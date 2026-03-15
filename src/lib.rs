#![deny(clippy::all)]

use napi_derive::napi;
use std::time::Duration;

mod os;

#[napi]
#[derive(Clone, Copy)]
pub enum Lock {
    Exclusive,
    Shared,
    Unlock,
}

#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct LockRange {
    pub offset: i64,
    pub length: i64,
}

/// Result of a single non-blocking lock attempt.
pub enum LockAttempt {
    Acquired,
    WouldBlock,
}

#[napi]
pub async fn lock(
    fd: os::FileDescriptor,
    lock: Lock,
    range: Option<LockRange>,
    options: Option<PollOptions>,
) -> napi::Result<()> {
    eprintln!("lock");
    poll_lock(fd, lock, range, options).await
}

#[napi]
pub fn lock_sync(fd: os::FileDescriptor, lock: Lock, range: Option<LockRange>) -> napi::Result<()> {
    eprintln!("lock_sync");
    let range = range.map(try_into_os_range).transpose()?;
    os::file_lock(fd, lock, range, true).map_err(io_error)?;
    Ok(())
}

#[napi]
pub async fn try_lock(
    fd: os::FileDescriptor,
    mode: Lock,
    range: Option<LockRange>,
) -> napi::Result<bool> {
    install_panic_hook();
    eprintln!("try_lock");
    let range = range.map(try_into_os_range).transpose()?;
    tokio::task::spawn_blocking(move || os::file_lock(fd, mode, range, false))
        .await
        .map_err(task_error)?
        .map(|a| matches!(a, LockAttempt::Acquired))
        .map_err(io_error)
}

#[napi]
pub fn try_lock_sync(
    fd: os::FileDescriptor,
    lock: Lock,
    range: Option<LockRange>,
) -> napi::Result<bool> {
    let range = range.map(try_into_os_range).transpose()?;
    let locked = os::file_lock(fd, lock, range, false).map_err(io_error)?;
    Ok(matches!(locked, LockAttempt::Acquired))
}

#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct PollOptions {
    pub poll_ms: Option<u32>,
    pub timeout: Option<u32>,
}

/// Poll a lock attempt in a loop with configurable interval and timeout.
async fn poll_lock(
    fd: os::FileDescriptor,
    mode: Lock,
    range: Option<LockRange>,
    options: Option<PollOptions>,
) -> napi::Result<()> {
    let range = range.map(try_into_os_range).transpose()?;

    let poll_ms = options.as_ref().and_then(|o| o.poll_ms).unwrap_or(10) as u64;
    let timeout = options
        .as_ref()
        .and_then(|o| o.timeout)
        .map(|t| Duration::from_millis(t as u64));

    let poll = async {
        loop {
            let locked = tokio::task::spawn_blocking(move || os::file_lock(fd, mode, range, false))
                .await
                .map_err(task_error)?
                .map_err(io_error)?;

            if matches!(locked, LockAttempt::Acquired) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(poll_ms)).await;
        }
    };

    match timeout {
        Some(t) => tokio::time::timeout(t, poll)
            .await
            .map_err(|_| timeout_error())?,
        None => poll.await,
    }
}

fn try_into_os_range(range: LockRange) -> std::io::Result<(os::Offset, os::Length)> {
    let (offset, length) = (range.offset as os::Offset, range.length as os::Length);
    if length == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Range length must be > 0. Zero-length (EOF) range locks are not supported.",
        ));
    }
    if offset.checked_add(length).is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "Range overflow: offset {} + length {} exceeds max",
                offset, length
            ),
        ));
    }

    Ok((offset, length))
}

fn io_error(err: std::io::Error) -> napi::Error {
    match err.kind() {
        std::io::ErrorKind::InvalidInput => {
            napi::Error::new(napi::Status::InvalidArg, err.to_string())
        }
        _ => napi::Error::new(napi::Status::GenericFailure, err.to_string()),
    }
}

fn task_error(err: tokio::task::JoinError) -> napi::Error {
    napi::Error::new(
        napi::Status::GenericFailure,
        format!("Lock task panicked: {}", err),
    )
}

fn timeout_error() -> napi::Error {
    napi::Error::from_reason("Timed out acquiring lock")
}

fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            eprintln!("RUST PANIC: {info}");
            eprintln!("{:?}", std::backtrace::Backtrace::force_capture());
        }));
    });
}
