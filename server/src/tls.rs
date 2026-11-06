//! Whether a request reached the panel over HTTPS.

/// Marks a request that reached the panel over HTTPS, through a tunnel, so its
/// cookies are set `Secure`.
#[derive(Clone, Copy)]
pub struct Https;
