fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_info",
            "autostart_enabled",
            "set_autostart",
            "open_github",
            "restart_desktop",
            "reveal_logs",
            "check_for_update",
            "install_update",
        ]),
    ))
    .expect("error while running tauri-build");
}
