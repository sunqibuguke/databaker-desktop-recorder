use eframe::egui::{
    self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, Frame, Margin, RichText,
    Stroke, ViewportBuilder,
};

use databaker_license_issuer::{
    clear_local_license, default_expiry_date, format_expiry_date, issue_license,
    load_private_key_pem, parse_expiry_date, probe_local_license, IssueLicenseInput,
    LocalLicenseProbe, DEFAULT_KID,
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

const INK: Color32 = Color32::from_rgb(0x11, 0x11, 0x10);
const SURFACE: Color32 = Color32::from_rgb(0x18, 0x18, 0x16);
const WELL: Color32 = Color32::from_rgb(0x14, 0x14, 0x13);
const LINE: Color32 = Color32::from_rgb(0x2C, 0x2C, 0x28);
const TEXT: Color32 = Color32::from_rgb(0xE8, 0xE6, 0xE3);
const MUTED: Color32 = Color32::from_rgb(0x8A, 0x87, 0x80);
const SOFT: Color32 = Color32::from_rgb(0xB6, 0xB3, 0xAC);
const CREAM: Color32 = Color32::from_rgb(0xF2, 0xEF, 0xE8);
const CREAM_INK: Color32 = Color32::from_rgb(0x16, 0x15, 0x13);
const ACCENT: Color32 = Color32::from_rgb(0x5C, 0xA8, 0xA3);
const DANGER: Color32 = Color32::from_rgb(0xC4, 0x5C, 0x62);
const DANGER_FILL: Color32 = Color32::from_rgb(0x2A, 0x16, 0x17);
const RADIUS: u8 = 6;

pub fn run() -> Result<(), eframe::Error> {
    let options = eframe::NativeOptions {
        viewport: ViewportBuilder::default()
            .with_inner_size([560.0, 720.0])
            .with_min_inner_size([500.0, 620.0])
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
    expiry: String,
    subject: String,
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
            expiry: default_expiry_date(None),
            subject: String::new(),
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
        let expires_at = if self.perpetual {
            None
        } else {
            match parse_expiry_date(&self.expiry) {
                Ok(value) => Some(value),
                Err(error) => {
                    self.error = error.to_string();
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
            days: None,
            perpetual: self.perpetual,
            expires_at,
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

    fn expiry_hint(&self) -> String {
        if self.perpetual {
            return "永久有效，不设到期日。".to_string();
        }
        match parse_expiry_date(&self.expiry) {
            Ok(value) => format!("到期日 {}", format_expiry_date(value)),
            Err(_) => "填写 YYYY-MM-DD，或勾选永久。".to_string(),
        }
    }
}

impl eframe::App for IssuerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default()
            .frame(
                Frame::NONE
                    .fill(INK)
                    .inner_margin(Margin::symmetric(28, 24)),
            )
            .show(ctx, |ui| {
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.label(RichText::new("授权注册机").size(28.0).strong().color(TEXT));
                        ui.add_space(6.0);
                        ui.label(
                            RichText::new("输入机器码和到期日，生成绑定该机器的离线授权。")
                                .size(14.0)
                                .color(MUTED),
                        );
                        ui.add_space(20.0);

                        card(ui, |ui| {
                            field_label(ui, "机器码", None);
                            ui.add(
                                egui::TextEdit::singleline(&mut self.machine)
                                    .desired_width(f32::INFINITY)
                                    .hint_text("A7K2-9M3P-Q4WX")
                                    .font(egui::TextStyle::Monospace),
                            );
                            ui.add_space(16.0);

                            ui.horizontal(|ui| {
                                field_label(ui, "授权日期", None);
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        ui.checkbox(&mut self.perpetual, "永久");
                                    },
                                );
                            });
                            ui.add_enabled(
                                !self.perpetual,
                                egui::TextEdit::singleline(&mut self.expiry)
                                    .desired_width(f32::INFINITY)
                                    .hint_text("2027-08-14")
                                    .font(egui::TextStyle::Monospace),
                            );
                            ui.add_space(4.0);
                            ui.label(RichText::new(self.expiry_hint()).size(12.0).color(MUTED));
                            ui.add_space(18.0);

                            field_label(ui, "工位名称", Some("选填"));
                            ui.add(
                                egui::TextEdit::singleline(&mut self.subject)
                                    .desired_width(f32::INFINITY)
                                    .hint_text("客户A-工位3"),
                            );
                            ui.add_space(4.0);
                            ui.label(
                                RichText::new("只作备忘，不影响激活。")
                                    .size(12.0)
                                    .color(MUTED),
                            );
                            ui.add_space(20.0);

                            let issue = egui::Button::new(
                                RichText::new("生成授权码")
                                    .size(15.0)
                                    .color(CREAM_INK)
                                    .strong(),
                            )
                            .fill(CREAM)
                            .corner_radius(CornerRadius::same(RADIUS))
                            .min_size(egui::vec2(ui.available_width(), 40.0));
                            if ui.add(issue).clicked() {
                                self.issue();
                            }
                        });

                        if !self.error.is_empty() {
                            ui.add_space(12.0);
                            ui.label(RichText::new(&self.error).color(DANGER));
                        }

                        if !self.ticket.is_empty() {
                            ui.add_space(16.0);
                            card(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ui.label(RichText::new("授权码").strong().color(TEXT));
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            let copy_label = if self.copied {
                                                "已复制"
                                            } else {
                                                "复制授权码"
                                            };
                                            if ui
                                                .add(
                                                    egui::Button::new(
                                                        RichText::new(copy_label).color(TEXT),
                                                    )
                                                    .fill(WELL)
                                                    .stroke(Stroke::new(1.0_f32, LINE))
                                                    .corner_radius(CornerRadius::same(RADIUS)),
                                                )
                                                .clicked()
                                            {
                                                ctx.copy_text(self.ticket.clone());
                                                self.copied = true;
                                            }
                                        },
                                    );
                                });
                                ui.add_space(10.0);
                                Frame::NONE
                                    .fill(WELL)
                                    .stroke(Stroke::new(1.0_f32, LINE))
                                    .corner_radius(CornerRadius::same(RADIUS))
                                    .inner_margin(Margin::same(12))
                                    .show(ui, |ui| {
                                        ui.add(
                                            egui::Label::new(
                                                RichText::new(&self.ticket)
                                                    .monospace()
                                                    .size(13.0)
                                                    .color(CREAM),
                                            )
                                            .wrap()
                                            .selectable(true),
                                        );
                                    });
                            });
                        }

                        ui.add_space(22.0);
                        ui.label(RichText::new("本机授权").strong().color(SOFT));
                        ui.add_space(4.0);
                        ui.label(
                            RichText::new("清空后采集软件会回到激活页。请先退出采集软件。")
                                .size(13.0)
                                .color(MUTED),
                        );
                        ui.add_space(10.0);
                        if self.local.files.is_empty() {
                            ui.label(
                                RichText::new("本机没有找到授权记录。")
                                    .size(13.0)
                                    .color(MUTED),
                            );
                        } else {
                            if let Some(claims) = &self.local.claims {
                                let subject = if claims.sub.is_empty() {
                                    "未填写工位名称".to_string()
                                } else {
                                    claims.sub.clone()
                                };
                                ui.label(RichText::new(format!("当前授权：{subject}")).color(SOFT));
                            }
                            for path in &self.local.files {
                                ui.label(
                                    RichText::new(path.display().to_string())
                                        .monospace()
                                        .small()
                                        .color(MUTED),
                                );
                            }
                        }
                        ui.add_space(12.0);
                        let clear_label = if self.confirm_clear {
                            "再点一次确认清空"
                        } else {
                            "清空本机授权"
                        };
                        let (fill, stroke, text) = if self.confirm_clear {
                            (DANGER, Stroke::new(1.0_f32, DANGER), CREAM)
                        } else {
                            (
                                DANGER_FILL,
                                Stroke::new(1.0_f32, Color32::from_rgb(0x4A, 0x24, 0x26)),
                                DANGER,
                            )
                        };
                        let clear =
                            egui::Button::new(RichText::new(clear_label).color(text).strong())
                                .fill(fill)
                                .stroke(stroke)
                                .corner_radius(CornerRadius::same(RADIUS))
                                .min_size(egui::vec2(160.0, 36.0));
                        if ui.add(clear).clicked() {
                            self.clear_local();
                        }
                        if !self.notice.is_empty() {
                            ui.add_space(10.0);
                            ui.label(RichText::new(&self.notice).color(ACCENT));
                        }
                        ui.add_space(8.0);
                    });
            });
    }
}

fn card(ui: &mut egui::Ui, add_contents: impl FnOnce(&mut egui::Ui)) {
    Frame::NONE
        .fill(SURFACE)
        .stroke(Stroke::new(1.0_f32, LINE))
        .corner_radius(CornerRadius::same(8))
        .inner_margin(Margin::same(20))
        .show(ui, add_contents);
}

fn field_label(ui: &mut egui::Ui, label: &str, badge: Option<&str>) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(label).size(13.0).color(SOFT));
        if let Some(badge) = badge {
            ui.label(RichText::new(badge).size(12.0).color(MUTED));
        }
    });
    ui.add_space(6.0);
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

    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = egui::vec2(10.0, 8.0);
    style.spacing.button_padding = egui::vec2(14.0, 8.0);
    style.spacing.interact_size.y = 34.0;
    ctx.set_style(style);

    let mut visuals = egui::Visuals::dark();
    visuals.override_text_color = Some(TEXT);
    visuals.panel_fill = INK;
    visuals.window_fill = INK;
    visuals.extreme_bg_color = WELL;
    visuals.window_stroke = Stroke::new(1.0_f32, LINE);
    visuals.window_corner_radius = CornerRadius::same(8);
    visuals.widgets.inactive.bg_fill = WELL;
    visuals.widgets.inactive.weak_bg_fill = WELL;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, LINE);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT);
    visuals.widgets.inactive.corner_radius = CornerRadius::same(RADIUS);
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(0x1F, 0x1F, 0x1C);
    visuals.widgets.hovered.weak_bg_fill = Color32::from_rgb(0x1F, 0x1F, 0x1C);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, Color32::from_rgb(0x4A, 0x4A, 0x44));
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, CREAM);
    visuals.widgets.hovered.corner_radius = CornerRadius::same(RADIUS);
    visuals.widgets.active.bg_fill = Color32::from_rgb(0x24, 0x24, 0x21);
    visuals.widgets.active.weak_bg_fill = Color32::from_rgb(0x24, 0x24, 0x21);
    visuals.widgets.active.bg_stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.active.corner_radius = CornerRadius::same(RADIUS);
    visuals.selection.bg_fill = Color32::from_rgb(0x2A, 0x4A, 0x48);
    visuals.selection.stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, MUTED);
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
