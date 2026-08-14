const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn encode(bytes: &[u8]) -> String {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut output = String::new();
    for &byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            let index = ((value >> (bits - 5)) & 31) as usize;
            output.push(ALPHABET[index] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        let index = ((value << (5 - bits)) & 31) as usize;
        output.push(ALPHABET[index] as char);
    }
    output
}

pub fn decode(input: &str) -> Result<Vec<u8>, String> {
    let normalized: String = input
        .chars()
        .map(|ch| match ch.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .filter(|ch| *ch != '-')
        .collect();
    if normalized.is_empty() || normalized.chars().any(|ch| !ALPHABET.contains(&(ch as u8))) {
        return Err("授权码编码无效".to_string());
    }

    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut bytes = Vec::new();
    for ch in normalized.chars() {
        let index = ALPHABET
            .iter()
            .position(|item| *item == ch as u8)
            .ok_or_else(|| "授权码编码无效".to_string())?;
        value = (value << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            bytes.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_ascii() {
        let raw = br#"{"v":1,"kid":"test1"}"#;
        assert_eq!(decode(&encode(raw)).unwrap(), raw);
    }
}
