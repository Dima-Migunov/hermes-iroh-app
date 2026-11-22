use std::path::{Path, PathBuf};

use crate::errors::AppError;

pub const APPLICATION_DIRECTORY: &str = "hermes-iroh-app";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    MacOs,
    Windows,
    Android,
}

pub fn current_platform() -> Platform {
    if cfg!(target_os = "android") {
        Platform::Android
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::MacOs
    } else {
        Platform::Linux
    }
}

pub fn data_dir() -> Result<PathBuf, AppError> {
    resolve_data_dir(
        current_platform(),
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        std::env::var_os("APPDATA").map(PathBuf::from),
    )
}

pub fn resolve_data_dir(
    platform: Platform,
    xdg_config_home: Option<PathBuf>,
    home: Option<PathBuf>,
    appdata: Option<PathBuf>,
) -> Result<PathBuf, AppError> {
    const MISSING_HOME: &str =
        "The user data directory could not be resolved because the home directory is unavailable.";

    match platform {
        Platform::Linux => {
            if let Some(directory) = xdg_config_home.filter(|path| !path.as_os_str().is_empty()) {
                return Ok(directory.join(APPLICATION_DIRECTORY));
            }
            let home = home.ok_or_else(|| AppError::configuration(MISSING_HOME))?;
            Ok(home.join(".config").join(APPLICATION_DIRECTORY))
        }
        Platform::MacOs => {
            let home = home.ok_or_else(|| AppError::configuration(MISSING_HOME))?;
            Ok(home
                .join("Library")
                .join("Application Support")
                .join(APPLICATION_DIRECTORY))
        }
        Platform::Windows => {
            let appdata = appdata.ok_or_else(|| {
                AppError::configuration(
                    "The user data directory could not be resolved because APPDATA is unavailable.",
                )
            })?;
            Ok(appdata.join(APPLICATION_DIRECTORY))
        }
        Platform::Android => Err(AppError::configuration(
            "The Android data directory must be resolved from the application context.",
        )),
    }
}

pub fn resolve_android_data_dir(app_data_dir: impl Into<PathBuf>) -> PathBuf {
    app_data_dir.into().join(APPLICATION_DIRECTORY)
}

pub fn client_key_path(data_dir: &Path) -> PathBuf {
    data_dir.join("client.key")
}

pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

pub fn history_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("history")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    #[test]
    fn linux_prefers_xdg_config_home() {
        let resolved = resolve_data_dir(
            Platform::Linux,
            Some(path("/custom/config")),
            Some(path("/home/user")),
            None,
        )
        .expect("resolved");

        assert_eq!(resolved, path("/custom/config/hermes-iroh-app"));
    }

    #[test]
    fn linux_falls_back_to_dot_config() {
        let resolved = resolve_data_dir(Platform::Linux, None, Some(path("/home/user")), None)
            .expect("resolved");

        assert_eq!(resolved, path("/home/user/.config/hermes-iroh-app"));
    }

    #[test]
    fn linux_treats_an_empty_xdg_value_as_unset() {
        let resolved = resolve_data_dir(
            Platform::Linux,
            Some(PathBuf::new()),
            Some(path("/home/user")),
            None,
        )
        .expect("resolved");

        assert_eq!(resolved, path("/home/user/.config/hermes-iroh-app"));
    }

    #[test]
    fn macos_uses_the_application_support_directory() {
        let resolved = resolve_data_dir(
            Platform::MacOs,
            Some(path("/ignored")),
            Some(path("/Users/user")),
            None,
        )
        .expect("resolved");

        assert_eq!(
            resolved,
            path("/Users/user/Library/Application Support/hermes-iroh-app")
        );
    }

    #[test]
    fn windows_uses_roaming_appdata() {
        let resolved = resolve_data_dir(
            Platform::Windows,
            None,
            Some(path("C:/Users/user")),
            Some(path("C:/Users/user/AppData/Roaming")),
        )
        .expect("resolved");

        assert_eq!(
            resolved,
            path("C:/Users/user/AppData/Roaming/hermes-iroh-app")
        );
    }

    #[test]
    fn reports_a_missing_home_directory() {
        let error = resolve_data_dir(Platform::Linux, None, None, None).expect_err("missing home");
        assert_eq!(error.code, crate::errors::ErrorCode::Configuration);
    }

    #[test]
    fn android_uses_the_application_private_directory() {
        let resolved =
            resolve_android_data_dir(path("/data/user/0/com.number0.hermesirohapp/files"));

        assert_eq!(
            resolved,
            path("/data/user/0/com.number0.hermesirohapp/files/hermes-iroh-app")
        );
    }

    #[test]
    fn android_does_not_fall_back_to_environment_directories() {
        let error = resolve_data_dir(
            Platform::Android,
            Some(path("/custom/config")),
            Some(path("/home/user")),
            Some(path("C:/Users/user/AppData/Roaming")),
        )
        .expect_err("android needs the app context");

        assert_eq!(error.code, crate::errors::ErrorCode::Configuration);
        assert!(error.message.contains("application context"));
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn desktop_platforms_are_not_android() {
        assert_ne!(current_platform(), Platform::Android);
    }
}
