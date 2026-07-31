use serde::Serialize;
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tauri_plugin_updater::UpdaterExt;

const GITHUB_URL: &str = "https://github.com/WSXYT/aihub-auto";

struct RouterProcess {
    child: Mutex<Option<CommandChild>>,
    shutdown_token: Mutex<Option<String>>,
    terminated: Mutex<Option<mpsc::Receiver<()>>>,
    stopping: Arc<AtomicBool>,
}
struct StartupError(Mutex<Option<String>>);

fn recover_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    port: u16,
    version: String,
    config_dir: String,
    startup_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    finished: bool,
}

fn desktop_port() -> u16 {
    if cfg!(debug_assertions) {
        8798
    } else {
        8787
    }
}

fn router_config_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        return PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())
            .join("aihub-auto");
    }
    if cfg!(target_os = "macos") {
        return PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library")
            .join("Application Support")
            .join("aihub-auto");
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
        })
        .join("aihub-auto")
}

fn desktop_shutdown_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}-{:x}", std::process::id(), nanos)
}

fn stop_router(app: &AppHandle) {
    let router = app.state::<RouterProcess>();
    router.stopping.store(true, Ordering::Release);
    let token = recover_lock(&router.shutdown_token).take();
    let terminated = recover_lock(&router.terminated).take();
    let child = recover_lock(&router.child).take();
    let Some(mut child) = child else {
        return;
    };
    if let (Some(token), Some(terminated)) = (token, terminated) {
        if child
            .write(format!("shutdown {token}\n").as_bytes())
            .is_ok()
            && terminated.recv_timeout(Duration::from_secs(5)).is_ok()
        {
            return;
        }
    }
    let _ = child.kill();
}

fn set_startup_error(app: &AppHandle, error: impl Into<String>) {
    recover_lock(&app.state::<StartupError>().0).replace(error.into());
}

fn router_healthy(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 256];
    let Ok(size) = stream.read(&mut response) else {
        return false;
    };
    let status = String::from_utf8_lossy(&response[..size]);
    status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")
}

fn wait_router_health(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if router_healthy(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn create_main_window(app: &AppHandle, port: u16) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        show_main(app);
        return Ok(());
    }
    let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/ui"))
        .expect("fixed localhost URL must parse");
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("aihub-auto")
        .inner_size(1180.0, 760.0)
        .min_inner_size(860.0, 620.0)
        .visible(true)
        .build()?;
    Ok(())
}

fn create_failure_window(app: &AppHandle) {
    let url = tauri::Url::parse("tauri://localhost/index.html")
        .expect("fixed local failure URL must parse");
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("aihub-auto - 启动失败")
        .inner_size(720.0, 480.0)
        .min_inner_size(560.0, 400.0)
        .build();
}

fn start_router(app: &AppHandle) -> Result<(), String> {
    let port = desktop_port();
    let config_dir = router_config_dir();
    let shutdown_token = desktop_shutdown_token();
    let sidecar = app
        .shell()
        .sidecar("aihub-auto-router")
        .map_err(|error| error.to_string())?
        .args(["--port", &port.to_string()])
        .env("AIHUB_AUTO_CONFIG_DIR", &config_dir)
        .env("AIHUB_AUTO_DESKTOP", "1")
        .env("AIHUB_AUTO_DESKTOP_SHUTDOWN_TOKEN", &shutdown_token);
    let (mut events, child) = sidecar.spawn().map_err(|error| error.to_string())?;
    let (terminated_tx, terminated_rx) = mpsc::sync_channel(1);
    {
        let router = app.state::<RouterProcess>();
        router.stopping.store(false, Ordering::Release);
        recover_lock(&router.shutdown_token).replace(shutdown_token);
        recover_lock(&router.terminated).replace(terminated_rx);
        recover_lock(&router.child).replace(child);
    }

    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
    let event_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reported = false;
        let mut startup_output = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    if reported {
                        continue;
                    }
                    startup_output.push_str(&String::from_utf8_lossy(&bytes));
                    if startup_output.contains("aihub-auto 已启动:") {
                        let _ = ready_tx.try_send(Ok(()));
                        reported = true;
                    } else if startup_output.len() > 4096 {
                        startup_output.drain(..startup_output.len() - 4096);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let router = event_handle.state::<RouterProcess>();
                    recover_lock(&router.child).take();
                    recover_lock(&router.shutdown_token).take();
                    let _ = terminated_tx.try_send(());
                    if !reported {
                        let detail = startup_output.trim();
                        let _ = ready_tx.try_send(Err(if detail.is_empty() {
                            format!("路由进程在启动前退出: {payload:?}")
                        } else {
                            format!("路由进程启动失败: {detail}")
                        }));
                    } else if !router.stopping.load(Ordering::Acquire) {
                        let error = format!("本地路由进程意外退出: {payload:?}");
                        let failure_handle = event_handle.clone();
                        let _ = event_handle.run_on_main_thread(move || {
                            set_startup_error(&failure_handle, error);
                            create_failure_window(&failure_handle);
                        });
                    }
                    break;
                }
                CommandEvent::Error(error) => {
                    if !reported {
                        let _ = ready_tx.try_send(Err(format!("路由进程错误: {error}")));
                    }
                    break;
                }
                _ => {}
            }
        }
        if !reported {
            let _ = ready_tx.try_send(Err("路由进程输出流提前结束".to_string()));
        }
    });

    let handle = app.clone();
    std::thread::spawn(move || {
        let startup = ready_rx
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| Err("等待路由启动超时".to_string()));
        let result = startup.and_then(|_| {
            wait_router_health(port, Duration::from_secs(3))
                .then_some(())
                .ok_or_else(|| "路由进程已启动，但健康检查未通过".to_string())
        });
        let run_handle = handle.clone();
        let _ = handle.run_on_main_thread(move || match result {
            Ok(()) => {
                if let Err(error) = create_main_window(&run_handle, port) {
                    set_startup_error(&run_handle, format!("创建主窗口失败: {error}"));
                    create_failure_window(&run_handle);
                }
            }
            Err(error) => {
                stop_router(&run_handle);
                set_startup_error(&run_handle, error);
                create_failure_window(&run_handle);
            }
        });
    });
    Ok(())
}

fn open_logs_view(app: &AppHandle) {
    show_main(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.dispatchEvent(new Event('desktop-open-logs'))");
    }
}

fn request_update_check(app: &AppHandle) {
    show_main(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.dispatchEvent(new Event('desktop-check-update'))");
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "运行日志", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &logs, &update, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("aihub-auto 路由器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "logs" => open_logs_view(app),
            "update" => request_update_check(app),
            "quit" => {
                stop_router(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
fn desktop_info(app: AppHandle) -> DesktopInfo {
    DesktopInfo {
        port: desktop_port(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        config_dir: router_config_dir().to_string_lossy().into_owned(),
        startup_error: recover_lock(&app.state::<StartupError>().0).clone(),
    }
}

#[tauri::command]
fn open_github(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(GITHUB_URL, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn restart_desktop(app: AppHandle) {
    stop_router(&app);
    app.restart();
}

#[tauri::command]
fn reveal_logs(app: AppHandle) -> Result<(), String> {
    let path = router_config_dir().join("app.log");
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(match update {
        Some(update) => UpdateInfo {
            available: true,
            version: Some(update.version),
            notes: update.body,
        },
        None => UpdateInfo {
            available: false,
            version: None,
            notes: None,
        },
    })
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let before_exit = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || stop_router(&before_exit))
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "当前已是最新版本".to_string())?;
    let progress_app = app.clone();
    let finished_app = app.clone();
    let downloaded = Arc::new(AtomicU64::new(0));
    let progress_downloaded = downloaded.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let current =
                    progress_downloaded.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let _ = progress_app.emit(
                    "desktop-update-progress",
                    UpdateProgress {
                        downloaded: current,
                        total,
                        finished: false,
                    },
                );
            },
            move || {
                let current = downloaded.load(Ordering::Relaxed);
                let _ = finished_app.emit(
                    "desktop-update-progress",
                    UpdateProgress {
                        downloaded: current,
                        total: Some(current),
                        finished: true,
                    },
                );
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    stop_router(&app);
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app)
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(RouterProcess {
            child: Mutex::new(None),
            shutdown_token: Mutex::new(None),
            terminated: Mutex::new(None),
            stopping: Arc::new(AtomicBool::new(false)),
        })
        .manage(StartupError(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            open_github,
            restart_desktop,
            reveal_logs,
            check_for_update,
            install_update
        ])
        .setup(|app| {
            build_tray(app)?;
            if let Err(error) = start_router(app.handle()) {
                log::error!("router sidecar start failed:{error}");
                set_startup_error(app.handle(), error);
                create_failure_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building aihub-auto desktop");
    app.run(|app, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_router(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn health_server(status: &str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
        let port = listener
            .local_addr()
            .expect("read test listener port")
            .port();
        let response = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept health request");
            let mut request = [0_u8; 128];
            let _ = stream.read(&mut request);
            stream
                .write_all(response.as_bytes())
                .expect("write health response");
        });
        port
    }

    #[test]
    fn health_check_requires_http_200() {
        assert!(router_healthy(health_server("200 OK")));
        assert!(!router_healthy(health_server("503 Service Unavailable")));
    }
}
