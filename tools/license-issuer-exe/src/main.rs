#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::ExitCode;

use databaker_license_issuer::{
    issue_license, issuer_password_ok, resolve_private_key_path, IssueLicenseInput, DEFAULT_KID,
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
                | "--password"
                | "--jti"
                | "--now-ms"
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
    issuer_password_ok(parsed.password.as_deref()).map_err(|error| error.to_string())?;
    let key_path = resolve_private_key_path(parsed.key.as_deref()).ok_or_else(|| {
        "读不到签发私钥。请用 --key 指定 PEM，或把 license-2026a.pem 放到程序同一目录。".to_string()
    })?;
    let private_key_pem = std::fs::read_to_string(&key_path)
        .map_err(|_| format!("读不到签发私钥：{}", key_path.display()))?;
    let ticket = issue_license(IssueLicenseInput {
        private_key_pem: &private_key_pem,
        kid: parsed.kid.as_deref().unwrap_or(DEFAULT_KID),
        subject: parsed.subject.as_deref().ok_or("缺少 --subject")?,
        machine_code: parsed.machine.as_deref().ok_or("缺少 --machine")?,
        now_ms: parsed.now_ms,
        jti: parsed.jti.as_deref(),
        days: parsed.days,
        perpetual: parsed.perpetual,
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
    password: Option<String>,
    jti: Option<String>,
    now_ms: Option<u64>,
}

fn parse_args(argv: &[String]) -> Result<Cli, String> {
    let mut cli = Cli {
        machine: None,
        subject: None,
        days: None,
        perpetual: false,
        kid: None,
        key: None,
        password: None,
        jti: None,
        now_ms: None,
    };
    let mut index = 0;
    while index < argv.len() {
        let token = argv[index].as_str();
        match token {
            "--perpetual" => cli.perpetual = true,
            "--machine" | "--subject" | "--days" | "--kid" | "--key" | "--password" | "--jti"
            | "--now-ms" => {
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
                    "--password" => cli.password = Some(value.clone()),
                    "--jti" => cli.jti = Some(value.clone()),
                    "--now-ms" => {
                        cli.now_ms = Some(
                            value
                                .parse::<u64>()
                                .map_err(|_| "签发时间无效".to_string())?,
                        );
                    }
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

  databaker-license-issuer --machine A7K2-9M3P-Q4WX --subject 客户A-工位3 [--days 365|--perpetual]

选项：
  --machine <CODE>   工位机器码
  --subject <NAME>   客户或工位名
  --days <N>         有效天数，默认 365
  --perpetual        永久授权
  --key <PEM>        签发私钥，默认同目录 license-2026a.pem
  --kid <ID>         密钥编号，默认 2026a
  --password <PWD>   注册机口令（若设置了 DATABAKER_LICENSE_ISSUER_PASSWORD）
"
    .to_string()
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
