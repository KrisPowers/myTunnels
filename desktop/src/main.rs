//! myTunnels on this computer as an app of its own: the panel in a window of
//! its own, with no browser around it. Remote devices keep using the panel
//! through a tunnel; this is the host's console.
//!
//! It opens the panel on this computer's loopback address, starting
//! myTunnels first when it is not running. Pages off the panel open in the
//! default browser. Opening it again brings the open window to the front.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::time::{Duration, Instant};

use desktop::{answering, beside, hidden, home, open_outside, page, panel, BACKGROUND};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::{NewWindowResponse, WebContext, WebViewBuilder};

const TITLE: &str = "myTunnels";

enum Ready {
    Panel,
    Failed(String),
}

fn main() {
    if desktop::already_open(TITLE) {
        return;
    }
    let event_loop = EventLoopBuilder::<Ready>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_inner_size(LogicalSize::new(1360.0, 860.0))
        .with_min_inner_size(LogicalSize::new(960.0, 600.0))
        .with_background_color(BACKGROUND)
        .build(&event_loop)
        .expect("cannot open a window");

    let url = panel();
    let ours = url.clone();
    // Its web data in the myTunnels folder: beside the program, an update
    // could not swap the folder while the window is open.
    let mut context = WebContext::new(Some(home().join("desktop")));
    let builder = WebViewBuilder::new_with_web_context(&mut context)
        .with_background_color(BACKGROUND)
        .with_hotkeys_zoom(false)
        .with_back_forward_navigation_gestures(false)
        .with_navigation_handler(move |to| {
            let inside =
                to.starts_with(&ours) || to.starts_with("about:") || to.starts_with("data:");
            if !inside {
                open_outside(&to);
            }
            inside
        })
        .with_new_window_req_handler(|to, _| {
            open_outside(&to);
            NewWindowResponse::Deny
        });
    let webview = if answering() {
        builder.with_url(&url)
    } else {
        start(event_loop.create_proxy());
        builder.with_html(page("Starting myTunnels", ""))
    }
    .build(&window)
    .expect("cannot open the panel");

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Ready::Panel) => {
                let _ = webview.load_url(&url);
            }
            Event::UserEvent(Ready::Failed(why)) => {
                let _ = webview.load_html(&page("myTunnels did not start", &why));
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *flow = ControlFlow::Exit,
            _ => {}
        }
    });
}

/// Starts myTunnels, now and with this computer, and says when the panel answers.
fn start(proxy: tao::event_loop::EventLoopProxy<Ready>) {
    std::thread::spawn(move || {
        let said = hidden(Command::new(beside("mytunnels")).arg("start")).output();
        let began = Instant::now();
        while !answering() {
            if began.elapsed() > Duration::from_secs(40) {
                let why = match said {
                    Ok(out) if !out.status.success() => String::from_utf8_lossy(&out.stderr).trim().to_owned(),
                    Err(err) => format!("cannot run mytunnels: {err}"),
                    _ => "It started but does not answer. Its log is log.txt in the myTunnels folder.".into(),
                };
                let _ = proxy.send_event(Ready::Failed(why));
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let _ = proxy.send_event(Ready::Panel);
    });
}
