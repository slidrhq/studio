// Release builds must not open a console window next to the studio.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    slidr_studio_lib::run();
}
