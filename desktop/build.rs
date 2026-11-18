//! Puts together what the programs carry inside them: the panel's font, for
//! the pages shown before the panel answers, and for setup the Windows build
//! it installs, the archive SETUP_PAYLOAD names. Without one, setup holds
//! nothing and says so.

use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    let font = "../ui/src/fonts/roboto.woff2";
    println!("cargo:rerun-if-changed={font}");
    let css = std::fs::read(font)
        .map(|bytes| {
            format!(
                "@font-face {{ font-family: \"Roboto\"; src: url(data:font/woff2;base64,{}) format(\"woff2\"); font-weight: 100 900; }}",
                base64(&bytes)
            )
        })
        .unwrap_or_default();
    std::fs::write(out.join("font.css"), css).unwrap();

    println!("cargo:rerun-if-env-changed=SETUP_PAYLOAD");
    println!("cargo:rerun-if-env-changed=SETUP_RELEASE");
    let payload = match std::env::var("SETUP_PAYLOAD") {
        Ok(path) => {
            println!("cargo:rerun-if-changed={path}");
            std::fs::read(&path).unwrap_or_else(|err| panic!("cannot read {path}: {err}"))
        }
        Err(_) => Vec::new(),
    };
    std::fs::write(out.join("payload.zip"), payload).unwrap();
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |n, &b| n << 8 | u32::from(b)) << (8 * (3 - chunk.len()));
        for i in 0..4 {
            text.push(if i <= chunk.len() {
                ABC[(n >> (18 - 6 * i)) as usize & 63] as char
            } else {
                '='
            });
        }
    }
    text
}
