use std::time::{SystemTime, UNIX_EPOCH};

use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::{Signer, SigningKey};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::crockford;
use crate::IssueError;

pub const LICENSE_TICKET_PREFIX: &str = "DBR1";
pub const DEFAULT_KID: &str = "2026a";
const MAX_SUBJECT_LENGTH: usize = 128;
const MAX_TICKET_LENGTH: usize = 4_096;

/// Hard sunset: the issuer refuses to start at 2028-01-01 00:00:00 +08:00.
pub const ISSUER_SUNSET_UNIX: i64 = 1_830_268_800;
pub const ISSUER_DISABLED_MESSAGE: &str = "授权注册机已停用：2027 年之后无法打开。";
/// Maximum issued lifetime. Calendar dates may use one extra UTC day of slack.
pub const MAX_LICENSE_DAYS: u32 = 365;
pub const MAX_LICENSE_MESSAGE: &str = "最长授权一年";
pub const NO_PERPETUAL_MESSAGE: &str = "不支持永久授权，最长授权一年";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LicenseClaims {
    pub v: u8,
    pub kid: String,
    pub jti: String,
    pub sub: String,
    pub mid: String,
    pub iat: i64,
    pub exp: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct IssueLicenseInput<'a> {
    pub private_key_pem: &'a str,
    pub kid: &'a str,
    pub subject: &'a str,
    pub machine_code: &'a str,
    pub now_ms: Option<u64>,
    pub jti: Option<&'a str>,
    pub days: Option<u32>,
    pub perpetual: bool,
    pub expires_at: Option<i64>,
}

pub fn issuer_now_unix(now_ms: Option<u64>) -> i64 {
    unix_seconds(now_ms.unwrap_or_else(system_now_ms))
}

pub fn assert_issuer_active(now_unix: i64) -> Result<(), IssueError> {
    if now_unix >= ISSUER_SUNSET_UNIX {
        return Err(IssueError::from(ISSUER_DISABLED_MESSAGE));
    }
    Ok(())
}

pub fn issue_license(input: IssueLicenseInput<'_>) -> Result<String, IssueError> {
    let now = issuer_now_unix(input.now_ms);
    assert_issuer_active(now)?;
    let mid = normalize_machine_code(input.machine_code)?;
    let sub = normalize_subject(input.subject)?;
    let kid = input.kid.trim();
    if kid.is_empty() {
        return Err(IssueError::from("密钥编号无效"));
    }
    let exp = resolve_expiry(input.perpetual, input.days, input.expires_at, now)?;
    let claims = LicenseClaims {
        v: 1,
        kid: kid.to_string(),
        jti: input
            .jti
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        sub,
        mid,
        iat: now,
        exp,
    };
    let payload = canonical_claims_json(&claims);
    let signing_key = SigningKey::from_pkcs8_pem(input.private_key_pem)
        .map_err(|_| IssueError::from("私钥无效"))?;
    let signature = signing_key.sign(payload.as_bytes());
    Ok(format!(
        "{LICENSE_TICKET_PREFIX}.{}.{}",
        crockford::encode(payload.as_bytes()),
        crockford::encode(&signature.to_bytes())
    ))
}

pub fn inspect_license_ticket(ticket: &str) -> Result<LicenseClaims, IssueError> {
    let normalized = normalize_ticket(ticket)?;
    let mut parts = normalized.split('.');
    let prefix = parts.next().unwrap_or_default();
    let payload_part = parts.next();
    let signature_part = parts.next();
    if prefix != LICENSE_TICKET_PREFIX
        || payload_part.is_none()
        || signature_part.is_none()
        || parts.next().is_some()
    {
        return Err(IssueError::from("授权码格式无效"));
    }
    let payload = crockford::decode(payload_part.unwrap())?;
    let signature = crockford::decode(signature_part.unwrap())?;
    if payload.is_empty() || signature.len() != 64 {
        return Err(IssueError::from("授权码格式无效"));
    }
    let json = String::from_utf8(payload).map_err(|_| IssueError::from("授权码格式无效"))?;
    let claims = parse_claims_json(&json)?;
    if canonical_claims_json(&claims) != json {
        return Err(IssueError::from("授权码格式无效"));
    }
    Ok(claims)
}

pub fn normalize_machine_code(value: &str) -> Result<String, IssueError> {
    let compact: String = value
        .chars()
        .map(|ch| match ch.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .filter(|ch| matches!(ch, '0'..='9' | 'A'..='H' | 'J' | 'K' | 'M' | 'N' | 'P'..='T' | 'V'..='Z'))
        .collect();
    if compact.chars().count() != 12 {
        return Err(IssueError::from("机器码格式无效"));
    }
    let chars: Vec<char> = compact.chars().collect();
    Ok(format!(
        "{}-{}-{}",
        chars[..4].iter().collect::<String>(),
        chars[4..8].iter().collect::<String>(),
        chars[8..12].iter().collect::<String>()
    ))
}

fn normalize_subject(value: &str) -> Result<String, IssueError> {
    let subject: String = value.nfkc().collect::<String>().trim().to_string();
    if utf16_len(&subject) > MAX_SUBJECT_LENGTH {
        return Err(IssueError::from("客户或工位名称无效"));
    }
    Ok(subject)
}

fn resolve_expiry(
    perpetual: bool,
    days: Option<u32>,
    expires_at: Option<i64>,
    now: i64,
) -> Result<Option<i64>, IssueError> {
    if perpetual {
        return Err(IssueError::from(NO_PERPETUAL_MESSAGE));
    }
    if let Some(exp) = expires_at {
        if exp <= now {
            return Err(IssueError::from("授权日期必须晚于今天"));
        }
        if exp > max_calendar_expiry(now) {
            return Err(IssueError::from(MAX_LICENSE_MESSAGE));
        }
        return Ok(Some(exp));
    }
    let days = days.unwrap_or(MAX_LICENSE_DAYS);
    if days < 1 {
        return Err(IssueError::from("授权天数无效"));
    }
    if days > MAX_LICENSE_DAYS {
        return Err(IssueError::from(MAX_LICENSE_MESSAGE));
    }
    Ok(Some(now + i64::from(days) * 86_400))
}

fn max_calendar_expiry(now: i64) -> i64 {
    // Last valid labeled day is today (UTC) plus 365 days; exp is the next midnight.
    now.div_euclid(86_400) * 86_400 + i64::from(MAX_LICENSE_DAYS + 1) * 86_400
}

pub fn default_expiry_date(now_ms: Option<u64>) -> String {
    let millis = now_ms.unwrap_or_else(system_now_ms);
    format_expiry_date(unix_seconds(millis) + i64::from(MAX_LICENSE_DAYS) * 86_400)
}

pub fn format_expiry_date(exclusive_unix_seconds: i64) -> String {
    let last_valid = exclusive_unix_seconds.saturating_sub(1);
    let (year, month, day) = civil_from_days(last_valid.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn parse_expiry_date(value: &str) -> Result<i64, IssueError> {
    let value = value.trim();
    let mut parts = value.split('-');
    let year = parse_date_part(parts.next(), "授权日期格式无效，请使用 YYYY-MM-DD")?;
    let month = parse_date_part(parts.next(), "授权日期格式无效，请使用 YYYY-MM-DD")?;
    let day = parse_date_part(parts.next(), "授权日期格式无效，请使用 YYYY-MM-DD")?;
    if parts.next().is_some() {
        return Err(IssueError::from("授权日期格式无效，请使用 YYYY-MM-DD"));
    }
    if !(1970..=2100).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(IssueError::from("授权日期无效"));
    }
    let days = days_from_civil(year, month as u32, day as u32);
    let (roundtrip_year, roundtrip_month, roundtrip_day) = civil_from_days(days);
    if i64::from(roundtrip_year) != year
        || i64::from(roundtrip_month) != month
        || i64::from(roundtrip_day) != day
    {
        return Err(IssueError::from("授权日期无效"));
    }
    // Labeled 到期日 is the last valid UTC day; exp is the exclusive next midnight.
    Ok((days + 1) * 86_400)
}

fn parse_date_part(value: Option<&str>, error: &str) -> Result<i64, IssueError> {
    let value = value
        .filter(|part| !part.is_empty())
        .ok_or_else(|| IssueError::from(error))?;
    value.parse::<i64>().map_err(|_| IssueError::from(error))
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let mut year = year;
    let month = i64::from(month);
    let day = i64::from(day);
    if month <= 2 {
        year -= 1;
    }
    let era = if year >= 0 { year } else { year - 399 }.div_euclid(400);
    let yoe = year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * shifted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    (year as i32, month as u32, day as u32)
}

fn normalize_ticket(ticket: &str) -> Result<String, IssueError> {
    let compact: String = ticket.chars().filter(|ch| !ch.is_whitespace()).collect();
    if compact.is_empty() || compact.len() > MAX_TICKET_LENGTH {
        return Err(IssueError::from("授权码无效"));
    }
    Ok(compact)
}

pub fn canonical_claims_json(claims: &LicenseClaims) -> String {
    let exp = match claims.exp {
        Some(value) => value.to_string(),
        None => "null".to_string(),
    };
    format!(
        "{{\"v\":{},\"kid\":{},\"jti\":{},\"sub\":{},\"mid\":{},\"iat\":{},\"exp\":{}}}",
        claims.v,
        json_string(&claims.kid),
        json_string(&claims.jti),
        json_string(&claims.sub),
        json_string(&claims.mid),
        claims.iat,
        exp
    )
}

fn parse_claims_json(json: &str) -> Result<LicenseClaims, IssueError> {
    let v = json_number_field(json, "v")? as u8;
    if v != 1 {
        return Err(IssueError::from("授权码版本无效"));
    }
    let kid = json_string_field(json, "kid")?;
    let jti = json_string_field(json, "jti")?;
    let sub = json_string_field(json, "sub")?;
    let mid = json_string_field(json, "mid")?;
    let iat = json_number_field(json, "iat")?;
    let exp = json_optional_number_field(json, "exp")?;
    if kid.trim().is_empty() || jti.trim().is_empty() || iat <= 0 {
        return Err(IssueError::from("授权码载荷无效"));
    }
    Ok(LicenseClaims {
        v,
        kid: kid.trim().to_string(),
        jti: jti.trim().to_string(),
        sub: normalize_subject(&sub)?,
        mid: normalize_machine_code(&mid)?,
        iat,
        exp,
    })
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn json_string_field(json: &str, key: &str) -> Result<String, IssueError> {
    let needle = format!("\"{key}\":\"");
    let start = json
        .find(&needle)
        .ok_or_else(|| IssueError::from("授权码载荷无效"))?
        + needle.len();
    let mut out = String::new();
    let mut chars = json[start..].chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Ok(out),
            '\\' => {
                let next = chars
                    .next()
                    .ok_or_else(|| IssueError::from("授权码载荷无效"))?;
                out.push(match next {
                    '"' => '"',
                    '\\' => '\\',
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    other => other,
                });
            }
            ch => out.push(ch),
        }
    }
    Err(IssueError::from("授权码载荷无效"))
}

fn json_number_field(json: &str, key: &str) -> Result<i64, IssueError> {
    json_optional_number_field(json, key)?.ok_or_else(|| IssueError::from("授权码载荷无效"))
}

fn json_optional_number_field(json: &str, key: &str) -> Result<Option<i64>, IssueError> {
    let needle = format!("\"{key}\":");
    let start = json
        .find(&needle)
        .ok_or_else(|| IssueError::from("授权码载荷无效"))?
        + needle.len();
    let rest = &json[start..];
    if rest.starts_with("null") {
        return Ok(None);
    }
    let end = rest.find([',', '}']).unwrap_or(rest.len());
    rest[..end]
        .parse::<i64>()
        .map(Some)
        .map_err(|_| IssueError::from("授权码载荷无效"))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn unix_seconds(now_ms: u64) -> i64 {
    (now_ms / 1_000) as i64
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const GOLDEN_DAYS: &str = "DBR1.FCH7C8HT64P24TV9CGH3M8KMCNSQ8C925GH6MX3948X24X39CDNPAX1D64H2R8KKENH24EH2WPQA5SM8PX0JVSDQMQJBV39K48P24VB9CGH3M8J16X5K4B9S9MSN0BAH6HBNG8HC49MP2X1278RKEE1P6CVKEDHG60P24SBRE0H3MC9R64VKJC9K6RR30Z8.NQ2WRXENJS77WYD341DSAWSJ234AY8GCGA4VCH3EYP0SGN69SJ1JD18ESZZZB4CYQGPQ004VH71J7RZFE2K6X2PVXJ3NQMP3M9JWE3G";
    const GOLDEN_PERPETUAL: &str = "DBR1.FCH7C8HT64P24TV9CGH3M8KMCNSQ8C925GH6MX3948X24SKFE9JQCSBJ48P24WVNC8H3M8Q5NTHED25Q84PYBDX5WJYRTCS25GH6TTB448X24G9Q9CS2TEAD6D82TM9MAXC24B12D5GQ88HT64VKGDHK6WVKCC1G5GH6AY3G48X6WXBCDHYG.33FEFYW7DSJE3HBBYRB1WKZT17K70FQTYR7E9RMA5PQZM793G8DFCAEZCQVFZKEH8XAQS6W1EBNWHN7HARV2FEXBEN0VYTCRGBR9R3G";

    fn fixture_key() -> String {
        let path = format!(
            "{}/../../scripts/fixtures/license-test-only-test1.pem",
            env!("CARGO_MANIFEST_DIR")
        );
        fs::read_to_string(path).expect("test fixture private key")
    }

    #[test]
    fn matches_node_issued_ticket() {
        let ticket = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "客户A-工位3",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(1_786_377_600_000),
            jti: Some("ticket-1"),
            days: Some(365),
            perpetual: false,
            expires_at: None,
        })
        .unwrap();
        assert_eq!(ticket, GOLDEN_DAYS);
    }

    #[test]
    fn rejects_perpetual_license() {
        let error = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "客户A-工位3",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(1_786_377_600_000),
            jti: Some("forever"),
            days: None,
            perpetual: true,
            expires_at: None,
        })
        .unwrap_err();
        assert_eq!(error.to_string(), NO_PERPETUAL_MESSAGE);
    }

    #[test]
    fn still_inspects_legacy_perpetual_ticket() {
        let claims = inspect_license_ticket(GOLDEN_PERPETUAL).unwrap();
        assert_eq!(claims.jti, "forever");
        assert_eq!(claims.exp, None);
    }

    #[test]
    fn rejects_more_than_one_year() {
        let error = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(1_786_377_600_000),
            jti: Some("too-long"),
            days: Some(366),
            perpetual: false,
            expires_at: None,
        })
        .unwrap_err();
        assert_eq!(error.to_string(), MAX_LICENSE_MESSAGE);
    }

    #[test]
    fn allows_default_calendar_year_and_rejects_the_next_day() {
        let now_ms = 1_786_377_600_000;
        let labeled = default_expiry_date(Some(now_ms));
        let allowed = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(now_ms),
            jti: Some("one-year"),
            days: None,
            perpetual: false,
            expires_at: Some(parse_expiry_date(&labeled).unwrap()),
        });
        assert!(allowed.is_ok(), "{}", allowed.unwrap_err());

        let error = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(now_ms),
            jti: Some("one-year-plus"),
            days: None,
            perpetual: false,
            expires_at: Some(parse_expiry_date("2027-08-11").unwrap()),
        })
        .unwrap_err();
        assert_eq!(error.to_string(), MAX_LICENSE_MESSAGE);
    }

    #[test]
    fn refuses_to_issue_after_2027() {
        let error = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(1_830_268_800_000),
            jti: Some("sunset"),
            days: Some(1),
            perpetual: false,
            expires_at: None,
        })
        .unwrap_err();
        assert_eq!(error.to_string(), ISSUER_DISABLED_MESSAGE);
        assert!(assert_issuer_active(ISSUER_SUNSET_UNIX - 1).is_ok());
        assert!(assert_issuer_active(ISSUER_SUNSET_UNIX).is_err());
    }

    #[test]
    fn normalizes_machine_code_like_node() {
        assert_eq!(
            normalize_machine_code("a7k2 9m3p q4wx").unwrap(),
            "A7K2-9M3P-Q4WX"
        );
        assert_eq!(
            normalize_machine_code("A7K2-9M3P-Q4WX").unwrap(),
            "A7K2-9M3P-Q4WX"
        );
        assert!(normalize_machine_code("short").is_err());
    }

    #[test]
    fn inspects_golden_payload() {
        let claims = inspect_license_ticket(GOLDEN_DAYS).unwrap();
        assert_eq!(claims.kid, "test1");
        assert_eq!(claims.jti, "ticket-1");
        assert_eq!(claims.sub, "客户A-工位3");
        assert_eq!(claims.mid, "A7K2-9M3P-Q4WX");
        assert_eq!(claims.iat, 1_786_377_600);
        assert_eq!(claims.exp, Some(1_817_913_600));
    }

    #[test]
    fn allows_empty_subject() {
        let ticket = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "   ",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(1_786_377_600_000),
            jti: Some("no-subject"),
            days: None,
            perpetual: false,
            expires_at: Some(1_817_913_600),
        })
        .unwrap();
        let claims = inspect_license_ticket(&ticket).unwrap();
        assert_eq!(claims.sub, "");
        assert_eq!(claims.exp, Some(1_817_913_600));
    }

    #[test]
    fn parses_and_formats_expiry_dates() {
        assert_eq!(parse_expiry_date("1970-01-01").unwrap(), 86_400);
        assert_eq!(parse_expiry_date("2000-01-01").unwrap(), 946_771_200);
        assert_eq!(parse_expiry_date("2026-08-14").unwrap(), 1_786_752_000);
        assert_eq!(format_expiry_date(1_786_752_000), "2026-08-14");
        assert_eq!(
            format_expiry_date(parse_expiry_date("2026-08-14").unwrap()),
            "2026-08-14"
        );
        assert_eq!(default_expiry_date(Some(1_786_320_000_000)), "2027-08-09");
        assert_eq!(default_expiry_date(Some(1_786_377_600_000)), "2027-08-10");
        assert!(parse_expiry_date("2026-02-29").is_err());
        assert!(parse_expiry_date("14/08/2026").is_err());
    }

    #[test]
    fn calendar_expiry_covers_the_labeled_utc_day() {
        let exp = parse_expiry_date("2026-08-14").unwrap();
        let ticket = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(1_786_377_600_000),
            jti: Some("calendar-day"),
            days: None,
            perpetual: false,
            expires_at: Some(exp),
        })
        .unwrap();
        let claims = inspect_license_ticket(&ticket).unwrap();
        assert_eq!(claims.exp, Some(1_786_752_000));
        assert_eq!(format_expiry_date(claims.exp.unwrap()), "2026-08-14");
    }
}
