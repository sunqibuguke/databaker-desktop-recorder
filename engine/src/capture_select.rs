//! Rank WASAPI/CPAL input configs so exclusive capture opens the hardware
//! endpoint (more channels) instead of the Windows mix geometry.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputConfigRank {
    pub format_score: u8,
    pub channels: u16,
}

/// Exclusive: higher sample-format score first, then more channels.
/// Shared: format score only; equal scores keep enumeration order.
#[cfg_attr(not(test), allow(dead_code))]
pub fn outranks(exclusive: bool, candidate: InputConfigRank, current: InputConfigRank) -> bool {
    if candidate.format_score != current.format_score {
        return candidate.format_score > current.format_score;
    }
    exclusive && candidate.channels > current.channels
}

pub fn sort_key(exclusive: bool, format_score: u8, channels: u16) -> (u8, u16) {
    if exclusive {
        (format_score, channels)
    } else {
        (format_score, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::{InputConfigRank, outranks, sort_key};

    #[test]
    fn exclusive_prefers_stereo_over_mono_at_the_same_format() {
        let mono = InputConfigRank {
            format_score: 7,
            channels: 1,
        };
        let stereo = InputConfigRank {
            format_score: 7,
            channels: 2,
        };
        assert!(outranks(true, stereo, mono));
        assert!(!outranks(true, mono, stereo));
        assert!(!outranks(false, stereo, mono));
    }

    #[test]
    fn exclusive_still_prefers_a_better_sample_format() {
        let stereo_i16 = InputConfigRank {
            format_score: 7,
            channels: 2,
        };
        let mono_f32 = InputConfigRank {
            format_score: 12,
            channels: 1,
        };
        assert!(outranks(true, mono_f32, stereo_i16));
        assert!(!outranks(true, stereo_i16, mono_f32));
    }

    #[test]
    fn exclusive_sort_key_orders_stereo_i16_ahead_of_mono_i16() {
        assert!(sort_key(true, 7, 2) > sort_key(true, 7, 1));
        assert_eq!(sort_key(false, 7, 2), sort_key(false, 7, 1));
    }
}
