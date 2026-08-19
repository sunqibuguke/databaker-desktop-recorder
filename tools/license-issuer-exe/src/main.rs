#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::ExitCode;

use databaker_license_issuer::{
    assert_issuer_active, clear_local_license, issue_license, issuer_now_unix,
    load_private_key_pem, IssueLicenseInput, DEFAULT_KID,
};

#[cfg(feature = "gui")]
mod gui;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if wants_cli(&args) || !cfg!(feature = "gui") {
        attach_parent_console();
        match run_cli(&args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        }
    } else {
        #[cfg(feature = "gui")]
        {
            if let Err(error) = refuse_if_sunset(None) {
                show_startup_failure(&error);
                return ExitCode::FAILURE;
            }
            if let Err(error) = gui::run() {
                attach_parent_console();
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        #[cfg(not(feature = "gui"))]
        {
            attach_parent_console();
            eprintln!("{}", usage());
            ExitCode::FAILURE
        }
    }
}

fn wants_cli(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--machine"
                | "--subject"
                | "--days"
                | "--perpetual"
                | "--key"
                | "--kid"
                | "--jti"
                | "--now-ms"
                | "--clear-local"
                | "--license-file"
                | "--help"
                | "-h"
        )
    })
}

fn run_cli(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", usage());
        return Ok(());
    }
    let parsed = parse_args(args)?;
    refuse_if_sunset(parsed.now_ms)?;
    if parsed.clear_local {
        let result = clear_local_license(parsed.license_file.as_deref())
            .map_err(|error| error.to_string())?;
        if result.removed.is_empty() {
            println!("本机没有授权记录。");
        } else {
            println!("已删除 {} 个授权文件：", result.removed.len());
            for path in result.removed {
                println!("{}", path.display());
            }
        }
        return Ok(());
    }
    let private_key_pem =
        load_private_key_pem(parsed.key.as_deref()).map_err(|error| error.to_string())?;
    let ticket = issue_license(IssueLicenseInput {
        private_key_pem: &private_key_pem,
        kid: parsed.kid.as_deref().unwrap_or(DEFAULT_KID),
        subject: parsed.subject.as_deref().unwrap_or(""),
        machine_code: parsed.machine.as_deref().ok_or("缺少 --machine")?,
        now_ms: parsed.now_ms,
        jti: parsed.jti.as_deref(),
        days: parsed.days,
        perpetual: parsed.perpetual,
        expires_at: None,
    })
    .map_err(|error| error.to_string())?;
    println!("{ticket}");
    Ok(())
}

struct Cli {
    machine: Option<String>,
    subject: Option<String>,
    days: Option<u32>,
    perpetual: bool,
    kid: Option<String>,
    key: Option<PathBuf>,
    jti: Option<String>,
    now_ms: Option<u64>,
    clear_local: bool,
    license_file: Option<PathBuf>,
}

fn parse_args(argv: &[String]) -> Result<Cli, String> {
    let mut cli = Cli {
        machine: None,
        subject: None,
        days: None,
        perpetual: false,
        kid: None,
        key: None,
        jti: None,
        now_ms: None,
        clear_local: false,
        license_file: None,
    };
    let mut index = 0;
    while index < argv.len() {
        let token = argv[index].as_str();
        match token {
            "--perpetual" => cli.perpetual = true,
            "--clear-local" => cli.clear_local = true,
            "--machine" | "--subject" | "--days" | "--kid" | "--key" | "--jti" | "--now-ms"
            | "--license-file" => {
                let value = argv
                    .get(index + 1)
                    .ok_or_else(|| format!("缺少 {token} 的值"))?;
                if value.starts_with("--") {
                    return Err(format!("缺少 {token} 的值"));
                }
                match token {
                    "--machine" => cli.machine = Some(value.clone()),
                    "--subject" => cli.subject = Some(value.clone()),
                    "--days" => {
                        cli.days = Some(
                            value
                                .parse::<u32>()
                                .map_err(|_| "授权天数无效".to_string())?,
                        );
                    }
                    "--kid" => cli.kid = Some(value.clone()),
                    "--key" => cli.key = Some(PathBuf::from(value)),
                    "--jti" => cli.jti = Some(value.clone()),
                    "--now-ms" => {
                        cli.now_ms = Some(
                            value
                                .parse::<u64>()
                                .map_err(|_| "签发时间无效".to_string())?,
                        );
                    }
                    "--license-file" => cli.license_file = Some(PathBuf::from(value)),
                    _ => {}
                }
                index += 1;
            }
            other if other.starts_with("--") => return Err(format!("未知参数：{other}")),
            other => return Err(format!("未知参数：{other}")),
        }
        index += 1;
    }
    Ok(cli)
}

fn usage() -> String {
    "DataBaker 授权注册机

不带参数时打开窗口。命令行：

  databaker-license-issuer --machine A7K2-9M3P-Q4WX [--days 365] [--subject 工位名]
  databaker-license-issuer --clear-local

选项：
  --machine <CODE>   工位机器码
  --days <N>         有效天数，默认 365，最长 365
  --subject <NAME>   工位名称，选填
  --clear-local      删除本机采集软件里的授权记录

硬限制：2027 年之后无法打开；单次授权最长一年。
"
    .to_string()
}

fn refuse_if_sunset(now_ms: Option<u64>) -> Result<(), String> {
    assert_issuer_active(issuer_now_unix(now_ms)).map_err(|error| error.to_string())
}

#[cfg(feature = "gui")]
fn show_startup_failure(message: &str) {
    attach_parent_console();
    eprintln!("{message}");
    #[cfg(windows)]
    show_windows_error(message);
    #[cfg(not(windows))]
    {
        let _ = gui::run_fatal(message);
    }
}

#[cfg(all(windows, feature = "gui"))]
fn show_windows_error(message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let text = wide(message);
    let caption = wide("DataBaker 授权注册机");
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR,
        );
    }
}

fn attach_parent_console() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{
            AttachConsole, SetConsoleCP, SetConsoleOutputCP, ATTACH_PARENT_PROCESS,
        };
        AttachConsole(ATTACH_PARENT_PROCESS);
        SetConsoleOutputCP(65001);
        SetConsoleCP(65001);
    }
}
