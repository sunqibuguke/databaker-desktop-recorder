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
const MAX_DAYS: u32 = 365 * 30;

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
}

pub fn issue_license(input: IssueLicenseInput<'_>) -> Result<String, IssueError> {
    let now = unix_seconds(input.now_ms.unwrap_or_else(now_ms));
    let mid = normalize_machine_code(input.machine_code)?;
    let sub = normalize_subject(input.subject)?;
    let kid = input.kid.trim();
    if kid.is_empty() {
        return Err(IssueError::from("密钥编号无效"));
    }
    let exp = resolve_expiry(input.perpetual, input.days, now)?;
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
    if subject.is_empty() || utf16_len(&subject) > MAX_SUBJECT_LENGTH {
        return Err(IssueError::from("客户或工位名称无效"));
    }
    Ok(subject)
}

fn resolve_expiry(perpetual: bool, days: Option<u32>, now: i64) -> Result<Option<i64>, IssueError> {
    if perpetual {
        return Ok(None);
    }
    let days = days.unwrap_or(365);
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(IssueError::from("授权天数无效"));
    }
    Ok(Some(now + i64::from(days) * 86_400))
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

fn now_ms() -> u64 {
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
        })
        .unwrap();
        assert_eq!(ticket, GOLDEN_DAYS);
    }

    #[test]
    fn matches_node_perpetual_ticket() {
        let ticket = issue_license(IssueLicenseInput {
            private_key_pem: &fixture_key(),
            kid: "test1",
            subject: "客户A-工位3",
            machine_code: "A7K2-9M3P-Q4WX",
            now_ms: Some(1_786_377_600_000),
            jti: Some("forever"),
            days: None,
            perpetual: true,
        })
        .unwrap();
        assert_eq!(ticket, GOLDEN_PERPETUAL);
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
}
