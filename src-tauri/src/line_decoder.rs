use crate::errors::AppError;

pub const DEFAULT_MAX_LINE_BYTES: usize = 1024 * 1024;

pub struct LineDecoder {
    pending: Vec<u8>,
    /// Offset already scanned for a newline, so a long line is not rescanned per chunk.
    scanned: usize,
    max_line_bytes: usize,
}

impl LineDecoder {
    pub fn new() -> Self {
        Self::with_max_line_bytes(DEFAULT_MAX_LINE_BYTES)
    }

    pub fn with_max_line_bytes(max_line_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            scanned: 0,
            max_line_bytes,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, AppError> {
        self.pending.extend_from_slice(chunk);

        let mut lines = Vec::new();
        let mut start = 0usize;

        for index in self.scanned..self.pending.len() {
            if self.pending[index] != b'\n' {
                continue;
            }

            let line_bytes = &self.pending[start..index];
            if line_bytes.len() > self.max_line_bytes {
                return Err(self.line_too_long());
            }
            lines.push(self.decode(line_bytes)?);
            start = index + 1;
        }

        if start > 0 {
            self.pending.drain(..start);
            self.scanned = 0;
        } else {
            self.scanned = self.pending.len();
        }

        if self.pending.len() > self.max_line_bytes {
            return Err(self.line_too_long());
        }

        Ok(lines)
    }

    pub fn end(&mut self) -> Result<Vec<String>, AppError> {
        if self.pending.is_empty() {
            return Ok(Vec::new());
        }

        if self.pending.len() > self.max_line_bytes {
            return Err(self.line_too_long());
        }

        let line = self.decode(&self.pending)?;
        self.pending.clear();
        self.scanned = 0;
        Ok(vec![line])
    }

    fn decode(&self, bytes: &[u8]) -> Result<String, AppError> {
        let mut end = bytes.len();
        if end > 0 && bytes[end - 1] == b'\r' {
            end -= 1;
        }

        std::str::from_utf8(&bytes[..end])
            .map(ToOwned::to_owned)
            .map_err(|_| AppError::protocol("The server sent invalid UTF-8."))
    }

    fn line_too_long(&self) -> AppError {
        AppError::protocol(format!(
            "A response line exceeded the {}-byte limit.",
            self.max_line_bytes
        ))
    }
}

impl Default for LineDecoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorCode;

    #[test]
    fn decodes_a_multibyte_character_split_across_reads() {
        let mut decoder = LineDecoder::new();
        let bytes = "héllo\n".as_bytes();

        assert_eq!(
            decoder.push(&bytes[..2]).expect("partial"),
            Vec::<String>::new()
        );
        assert_eq!(decoder.push(&bytes[2..]).expect("rest"), vec!["héllo"]);
    }

    #[test]
    fn buffers_a_frame_split_across_reads() {
        let mut decoder = LineDecoder::new();
        assert!(decoder
            .push(br#"{"type":"del"#)
            .expect("partial")
            .is_empty());
        assert_eq!(
            decoder.push(b"ta\",\"content\":\"hi\"}\n").expect("rest"),
            vec![r#"{"type":"delta","content":"hi"}"#]
        );
    }

    #[test]
    fn returns_multiple_frames_from_one_read() {
        let mut decoder = LineDecoder::new();
        assert_eq!(
            decoder.push(b"one\ntwo\nthree\n").expect("lines"),
            vec!["one", "two", "three"]
        );
    }

    #[test]
    fn strips_a_trailing_carriage_return() {
        let mut decoder = LineDecoder::new();
        assert_eq!(
            decoder.push(b"{\"a\":1}\r\n").expect("line"),
            vec!["{\"a\":1}"]
        );
    }

    #[test]
    fn returns_nothing_at_eof_without_buffered_data() {
        let mut decoder = LineDecoder::new();
        assert!(decoder.end().expect("eof").is_empty());
    }

    #[test]
    fn flushes_a_trailing_line_at_eof() {
        let mut decoder = LineDecoder::new();
        decoder.push(b"{\"a\":").expect("partial");
        assert_eq!(decoder.end().expect("eof"), vec!["{\"a\":"]);
    }

    #[test]
    fn rejects_a_line_over_the_cap() {
        let mut decoder = LineDecoder::new();
        let oversized = vec![b'a'; DEFAULT_MAX_LINE_BYTES + 1];

        let error = decoder.push(&oversized).expect_err("too long");
        assert_eq!(error.code, ErrorCode::Protocol);
    }

    #[test]
    fn rejects_invalid_utf8() {
        let mut decoder = LineDecoder::new();
        let error = decoder
            .push(&[0xff, 0xfe, 0x0a])
            .expect_err("invalid utf-8");
        assert!(error.message.to_lowercase().contains("invalid utf-8"));
    }
    #[test]
    fn resumes_scanning_from_the_last_offset_without_rescanning() {
        let mut decoder = LineDecoder::new();
        let partial = vec![b'a'; 4096];

        assert!(decoder.push(&partial).expect("partial").is_empty());
        assert!(decoder.push(&partial).expect("partial").is_empty());
        assert!(decoder.push(&partial).expect("partial").is_empty());

        let mut tail = vec![b'b'; 10];
        tail.push(b'\n');
        let lines = decoder.push(&tail).expect("complete");

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 4096 * 3 + 10);
        assert!(lines[0].starts_with("aaa") && lines[0].ends_with("bbbbbbbbbb"));
    }

    #[test]
    fn returns_frames_split_across_many_small_chunks_in_order() {
        let mut decoder = LineDecoder::new();
        let payload = b"{\"type\":\"start\"}\n{\"type\":\"done\"}\n";
        let mut lines = Vec::new();

        for byte in payload {
            lines.extend(decoder.push(&[*byte]).expect("chunk"));
        }

        assert_eq!(lines, vec![r#"{"type":"start"}"#, r#"{"type":"done"}"#]);
    }
}
