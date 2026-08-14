use std::path::PathBuf;

use eframe::egui::{
    self, Color32, FontData, FontDefinitions, FontFamily, RichText, ViewportBuilder,
};

use databaker_license_issuer::{
    issue_license, issuer_password_ok, resolve_private_key_path, IssueLicenseInput, DEFAULT_KID,
};

const CJK_FONT_CANDIDATES: &[&str] = &[
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyh.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
];

pub fn run() -> Result<(), eframe::Error> {
    let options = eframe::NativeOptions {
        viewport: ViewportBuilder::default()
            .with_inner_size([560.0, 640.0])
            .with_min_inner_size([480.0, 560.0])
            .with_title("DataBaker 授权注册机"),
        ..Default::default()
    };
    eframe::run_native(
        "DataBaker 授权注册机",
        options,
        Box::new(|cc| {
            setup_style(&cc.egui_ctx);
            Ok(Box::new(IssuerApp::new()))
        }),
    )
}

struct IssuerApp {
    password: String,
    machine: String,
    subject: String,
    days: String,
    perpetual: bool,
    key_path: String,
    ticket: String,
    error: String,
    copied: bool,
}

impl IssuerApp {
    fn new() -> Self {
        let key_path = resolve_private_key_path(None)
            .map(|path| path.display().to_string())
            .unwrap_or_default();
        Self {
            password: String::new(),
            machine: String::new(),
            subject: String::new(),
            days: "365".to_string(),
            perpetual: false,
            key_path,
            ticket: String::new(),
            error: String::new(),
            copied: false,
        }
    }

    fn issue(&mut self) {
        self.copied = false;
        self.ticket.clear();
        self.error.clear();
        if let Err(error) = issuer_password_ok(Some(&self.password)) {
            self.error = error.to_string();
            return;
        }
        let key_path = self.key_path.trim();
        if key_path.is_empty() {
            self.error = "请选择签发私钥 PEM".to_string();
            return;
        }
        let private_key_pem = match std::fs::read_to_string(key_path) {
            Ok(value) => value,
            Err(_) => {
                self.error = format!("读不到签发私钥：{key_path}");
                return;
            }
        };
        let days = if self.perpetual {
            None
        } else {
            match self.days.trim().parse::<u32>() {
                Ok(value) => Some(value),
                Err(_) => {
                    self.error = "授权天数无效".to_string();
                    return;
                }
            }
        };
        match issue_license(IssueLicenseInput {
            private_key_pem: &private_key_pem,
            kid: DEFAULT_KID,
            subject: &self.subject,
            machine_code: &self.machine,
            now_ms: None,
            jti: None,
            days,
            perpetual: self.perpetual,
        }) {
            Ok(ticket) => self.ticket = ticket,
            Err(error) => self.error = error.to_string(),
        }
    }

    fn browse_key(&mut self) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("PEM", &["pem"])
            .set_title("选择签发私钥")
            .pick_file()
        {
            self.key_path = path.display().to_string();
        }
    }
}

impl eframe::App for IssuerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.add_space(10.0);
            ui.label(RichText::new("DataBaker 授权注册机").size(22.0).strong());
            ui.add_space(6.0);
            ui.label(
                RichText::new("输入工位机器码和客户名称，生成绑定该机器的离线授权码。私钥只放在本机，不要随采集安装包分发。")
                    .size(14.0)
                    .color(Color32::from_rgb(0x9a, 0x9a, 0x9a)),
            );
            ui.add_space(16.0);

            labeled_field(ui, "注册机口令（若公司设置了口令）", |ui| {
                ui.add(egui::TextEdit::singleline(&mut self.password).password(true).desired_width(f32::INFINITY));
            });
            labeled_field(ui, "私钥 PEM", |ui| {
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.key_path).desired_width(ui.available_width() - 88.0));
                    if ui.button("浏览").clicked() {
                        self.browse_key();
                    }
                });
            });
            labeled_field(ui, "机器码", |ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.machine)
                        .desired_width(f32::INFINITY)
                        .hint_text("A7K2-9M3P-Q4WX"),
                );
            });
            labeled_field(ui, "客户 / 工位名", |ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.subject)
                        .desired_width(f32::INFINITY)
                        .hint_text("客户A-工位3"),
                );
            });

            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.label(RichText::new("有效天数").color(Color32::from_rgb(0xb9, 0xb9, 0xb9)));
                    ui.add_enabled(
                        !self.perpetual,
                        egui::TextEdit::singleline(&mut self.days).desired_width(180.0),
                    );
                });
                ui.add_space(16.0);
                ui.vertical(|ui| {
                    ui.add_space(22.0);
                    ui.checkbox(&mut self.perpetual, "永久");
                });
            });

            ui.add_space(14.0);
            let issue = egui::Button::new(RichText::new("生成授权码").color(Color32::from_rgb(0x0c, 0x20, 0x1f)).strong())
                .fill(Color32::from_rgb(0x67, 0xbd, 0xb8))
                .min_size(egui::vec2(120.0, 34.0));
            if ui.add(issue).clicked() {
                self.issue();
            }

            if !self.error.is_empty() {
                ui.add_space(10.0);
                ui.label(RichText::new(&self.error).color(Color32::from_rgb(0xef, 0x6a, 0x72)));
            }

            if !self.ticket.is_empty() {
                ui.add_space(16.0);
                ui.label("授权码");
                egui::Frame::NONE
                    .fill(Color32::from_rgb(0x1b, 0x1d, 0x1c))
                    .stroke(egui::Stroke::new(1.0_f32, Color32::from_rgb(0x3a, 0x3a, 0x3a)))
                    .inner_margin(10.0)
                    .show(ui, |ui| {
                        ui.add(
                            egui::Label::new(RichText::new(&self.ticket).monospace().color(Color32::from_rgb(0xe6, 0xe6, 0xe6)))
                                .wrap(),
                        );
                    });
                ui.add_space(10.0);
                let copy_label = if self.copied { "已复制" } else { "复制授权码" };
                if ui.button(copy_label).clicked() {
                    ctx.copy_text(self.ticket.clone());
                    self.copied = true;
                }
            }

            if PathBuf::from(self.key_path.trim()).is_file() {
                ui.add_space(18.0);
                ui.label(
                    RichText::new("已找到私钥，可以签发。")
                        .small()
                        .color(Color32::from_rgb(0x67, 0xbd, 0xb8)),
                );
            }
        });
    }
}

fn labeled_field(ui: &mut egui::Ui, label: &str, add_contents: impl FnOnce(&mut egui::Ui)) {
    ui.label(RichText::new(label).color(Color32::from_rgb(0xb9, 0xb9, 0xb9)));
    add_contents(ui);
    ui.add_space(10.0);
}

fn setup_style(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    if let Some(font) = load_cjk_font() {
        fonts.font_data.insert("cjk".into(), font.into());
        fonts
            .families
            .entry(FontFamily::Proportional)
            .or_default()
            .insert(0, "cjk".into());
        fonts
            .families
            .entry(FontFamily::Monospace)
            .or_default()
            .push("cjk".into());
    }
    ctx.set_fonts(fonts);

    let mut visuals = egui::Visuals::dark();
    visuals.override_text_color = Some(Color32::from_rgb(0xe6, 0xe6, 0xe6));
    visuals.panel_fill = Color32::from_rgb(0x16, 0x16, 0x16);
    visuals.window_fill = Color32::from_rgb(0x16, 0x16, 0x16);
    visuals.extreme_bg_color = Color32::from_rgb(0x1f, 0x22, 0x21);
    visuals.widgets.inactive.bg_fill = Color32::from_rgb(0x2b, 0x2b, 0x2b);
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(0x3a, 0x3a, 0x3a);
    visuals.widgets.active.bg_fill = Color32::from_rgb(0x67, 0xbd, 0xb8);
    visuals.selection.bg_fill = Color32::from_rgb(0x67, 0xbd, 0xb8);
    visuals.widgets.inactive.fg_stroke.color = Color32::from_rgb(0xd6, 0xd6, 0xd6);
    ctx.set_visuals(visuals);
}

fn load_cjk_font() -> Option<FontData> {
    for path in CJK_FONT_CANDIDATES {
        if let Ok(bytes) = std::fs::read(path) {
            let mut font = FontData::from_owned(bytes);
            font.index = 0;
            return Some(font);
        }
    }
    None
}
