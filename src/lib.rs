#![deny(clippy::all)]

use napi_derive::napi;
use std::time::Duration;

mod os;

/// Lock mode passed to the native OS locking call.
#[napi]
#[derive(Clone, Copy)]
pub enum Lock {
    Exclusive,
    Shared,
    Unlock,
}

/// Byte range within a file. Offset and length are signed to allow
/// validation at the Rust boundary before casting to the OS types.
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

/// Acquire a lock, polling until available or timeout is reached.
#[napi]
pub async fn lock(
    fd: os::FileDescriptor,
    lock: Lock,
    range: Option<LockRange>,
    options: Option<PollOptions>,
) -> napi::Result<()> {
    poll_lock(fd, lock, range, options).await
}

/// Acquire a lock synchronously (blocks the thread).
#[napi]
pub fn lock_sync(fd: os::FileDescriptor, lock: Lock, range: Option<LockRange>) -> napi::Result<()> {
    let range = range.map(TryInto::try_into).transpose()?;
    os::file_lock(fd, lock, range, true).map_err(io_error)?;
    Ok(())
}

/// Try to acquire a lock without waiting. Returns `true` if acquired.
#[napi]
pub async fn try_lock(
    fd: os::FileDescriptor,
    mode: Lock,
    range: Option<LockRange>,
) -> napi::Result<bool> {
    let range = range.map(TryInto::try_into).transpose()?;
    tokio::task::spawn_blocking(move || os::file_lock(fd, mode, range, false))
        .await
        .map_err(task_error)?
        .map(|a| matches!(a, LockAttempt::Acquired))
        .map_err(io_error)
}

/// Synchronous non-blocking lock attempt. Returns `true` if acquired.
#[napi]
pub fn try_lock_sync(
    fd: os::FileDescriptor,
    lock: Lock,
    range: Option<LockRange>,
) -> napi::Result<bool> {
    let range = range.map(TryInto::try_into).transpose()?;
    let locked = os::file_lock(fd, lock, range, false).map_err(io_error)?;
    Ok(matches!(locked, LockAttempt::Acquired))
}

/// Options for the polling lock loop.
#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct PollOptions {
    pub poll_ms: Option<u32>,
    pub timeout: Option<u32>,
    /// Multiplier applied to the poll interval after each failed attempt.
    /// For example, `2.0` doubles the delay each iteration (exponential backoff).
    pub backoff: Option<f64>,
}

/// Poll a non-blocking lock in a loop until acquired or timeout expires.
/// The entire loop runs inside a single `spawn_blocking` call to avoid
/// repeated task spawning overhead.
async fn poll_lock(
    fd: os::FileDescriptor,
    mode: Lock,
    range: Option<LockRange>,
    options: Option<PollOptions>,
) -> napi::Result<()> {
    let range = range.map(TryInto::try_into).transpose()?;

    let poll_ms = options.as_ref().and_then(|o| o.poll_ms).unwrap_or(10) as f64;
    let backoff = options.as_ref().and_then(|o| o.backoff).unwrap_or(1.0);
    let timeout = options
        .as_ref()
        .and_then(|o| o.timeout)
        .map(|t| Duration::from_millis(t as u64));

    tokio::task::spawn_blocking(move || {
        let deadline = timeout.map(|t| std::time::Instant::now() + t);
        let mut delay_ms = poll_ms;
        loop {
            let result = os::file_lock(fd, mode, range, false).map_err(io_error)?;
            if matches!(result, LockAttempt::Acquired) {
                return Ok(());
            }
            if let Some(d) = deadline {
                if std::time::Instant::now() >= d {
                    return Err(timeout_error());
                }
            }
            std::thread::sleep(Duration::from_millis(delay_ms as u64));
            delay_ms *= backoff;
        }
    })
    .await
    .map_err(task_error)?
}

impl TryInto<(os::Offset, os::Length)> for LockRange {
    type Error = std::io::Error;

    fn try_into(self) -> Result<(os::Offset, os::Length), Self::Error> {
        if self.offset < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Range offset cannot be negative.",
            ));
        }

        if self.length <= 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Range length must be > 0. Zero-length (EOF) range locks are not supported.",
            ));
        }

        let (offset, length) = (self.offset as os::Offset, self.length as os::Length);
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
