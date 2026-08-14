use eframe::egui::{
    self, Color32, FontData, FontDefinitions, FontFamily, RichText, ViewportBuilder,
};

use databaker_license_issuer::{
    clear_local_license, issue_license, load_private_key_pem, probe_local_license,
    IssueLicenseInput, LocalLicenseProbe, DEFAULT_KID,
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
            .with_inner_size([520.0, 620.0])
            .with_min_inner_size([460.0, 520.0])
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
    machine: String,
    subject: String,
    days: String,
    perpetual: bool,
    ticket: String,
    error: String,
    notice: String,
    copied: bool,
    local: LocalLicenseProbe,
    confirm_clear: bool,
}

impl IssuerApp {
    fn new() -> Self {
        Self {
            machine: String::new(),
            subject: String::new(),
            days: "365".to_string(),
            perpetual: false,
            ticket: String::new(),
            error: String::new(),
            notice: String::new(),
            copied: false,
            local: probe_local_license(None),
            confirm_clear: false,
        }
    }

    fn issue(&mut self) {
        self.copied = false;
        self.confirm_clear = false;
        self.ticket.clear();
        self.error.clear();
        self.notice.clear();
        let private_key_pem = match load_private_key_pem(None) {
            Ok(value) => value,
            Err(error) => {
                self.error = error.to_string();
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

    fn clear_local(&mut self) {
        self.ticket.clear();
        self.error.clear();
        self.notice.clear();
        self.local = probe_local_license(None);
        if self.local.files.is_empty() {
            self.confirm_clear = false;
            self.notice = "本机没有授权记录。".to_string();
            return;
        }
        if !self.confirm_clear {
            self.confirm_clear = true;
            return;
        }
        match clear_local_license(None) {
            Ok(result) if result.removed.is_empty() => {
                self.confirm_clear = false;
                self.notice = "本机没有授权记录。".to_string();
            }
            Ok(result) => {
                self.confirm_clear = false;
                self.notice = format!(
                    "已删除 {} 个授权文件。请重新打开采集软件。",
                    result.removed.len()
                );
            }
            Err(error) => {
                self.confirm_clear = false;
                self.error = error.to_string();
            }
        }
        self.local = probe_local_license(None);
    }
}

impl eframe::App for IssuerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.add_space(10.0);
                ui.label(RichText::new("DataBaker 授权注册机").size(22.0).strong());
                ui.add_space(6.0);
                ui.label(
                    RichText::new("输入工位机器码和客户名称，生成绑定该机器的离线授权码。")
                        .size(14.0)
                        .color(Color32::from_rgb(0x9a, 0x9a, 0x9a)),
                );
                ui.add_space(16.0);

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
                        ui.label(
                            RichText::new("有效天数").color(Color32::from_rgb(0xb9, 0xb9, 0xb9)),
                        );
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
                let issue = egui::Button::new(
                    RichText::new("生成授权码")
                        .color(Color32::from_rgb(0x0c, 0x20, 0x1f))
                        .strong(),
                )
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
                        .stroke(egui::Stroke::new(
                            1.0_f32,
                            Color32::from_rgb(0x3a, 0x3a, 0x3a),
                        ))
                        .inner_margin(10.0)
                        .show(ui, |ui| {
                            ui.add(
                                egui::Label::new(
                                    RichText::new(&self.ticket)
                                        .monospace()
                                        .color(Color32::from_rgb(0xe6, 0xe6, 0xe6)),
                                )
                                .wrap(),
                            );
                        });
                    ui.add_space(10.0);
                    let copy_label = if self.copied {
                        "已复制"
                    } else {
                        "复制授权码"
                    };
                    if ui.button(copy_label).clicked() {
                        ctx.copy_text(self.ticket.clone());
                        self.copied = true;
                    }
                }

                ui.add_space(22.0);
                ui.separator();
                ui.add_space(12.0);
                ui.label(RichText::new("本机授权").strong());
                ui.add_space(4.0);
                ui.label(
                    RichText::new("清空后采集软件会回到激活页。请先退出采集软件再操作。")
                        .color(Color32::from_rgb(0x9a, 0x9a, 0x9a)),
                );
                ui.add_space(8.0);
                if self.local.files.is_empty() {
                    ui.label(
                        RichText::new("本机没有找到授权记录。")
                            .color(Color32::from_rgb(0xb9, 0xb9, 0xb9)),
                    );
                } else {
                    if let Some(claims) = &self.local.claims {
                        ui.label(format!("当前授权：{}", claims.sub));
                    }
                    for path in &self.local.files {
                        ui.label(
                            RichText::new(path.display().to_string())
                                .monospace()
                                .small()
                                .color(Color32::from_rgb(0xb9, 0xb9, 0xb9)),
                        );
                    }
                }
                ui.add_space(10.0);
                let clear_label = if self.confirm_clear {
                    "再点一次确认清空"
                } else {
                    "清空本机授权"
                };
                let clear = egui::Button::new(
                    RichText::new(clear_label)
                        .color(Color32::from_rgb(0xff, 0xf0, 0xf0))
                        .strong(),
                )
                .fill(Color32::from_rgb(0xef, 0x6a, 0x72))
                .min_size(egui::vec2(140.0, 34.0));
                if ui.add(clear).clicked() {
                    self.clear_local();
                }
                if !self.notice.is_empty() {
                    ui.add_space(10.0);
                    ui.label(
                        RichText::new(&self.notice).color(Color32::from_rgb(0x67, 0xbd, 0xb8)),
                    );
                }
                ui.add_space(16.0);
            });
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
