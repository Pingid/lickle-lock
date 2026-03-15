#![deny(clippy::all)]

use napi_derive::napi;
use std::time::Duration;

mod os;

#[derive(Clone, Copy)]
enum Lock {
    Exclusive,
    Shared,
    Unlock,
}

/// Result of a single non-blocking lock attempt.
pub enum LockAttempt {
    Acquired,
    WouldBlock,
}

/// Acquire an exclusive lock, polling until available or timeout.
#[napi]
pub async fn exclusive(
    fd: os::FileDescriptor,
    options: Option<BlockingOptions>,
) -> napi::Result<()> {
    acquire(fd, Lock::Exclusive, options).await
}

/// Acquire a shared lock, polling until available or timeout.
#[napi]
pub async fn shared(fd: os::FileDescriptor, options: Option<BlockingOptions>) -> napi::Result<()> {
    acquire(fd, Lock::Shared, options).await
}

/// Try to acquire an exclusive lock without waiting. Returns true if acquired.
///
/// Although the underlying OS call (`LOCK_NB` / `LOCKFILE_FAIL_IMMEDIATELY`) does not
/// block, this function is still async because it dispatches via `spawn_blocking`.
/// This is intentional: calling into FFI/syscalls directly on the async executor thread
/// risks stalling the runtime on network-backed or otherwise slow filesystems (e.g. NFS).
#[napi]
pub async fn try_exclusive(
    fd: os::FileDescriptor,
    options: Option<NonBlockingOptions>,
) -> napi::Result<bool> {
    try_acquire(fd, Lock::Exclusive, options).await
}

/// Try to acquire a shared lock without waiting. Returns true if acquired.
///
/// Although the underlying OS call (`LOCK_NB` / `LOCKFILE_FAIL_IMMEDIATELY`) does not
/// block, this function is still async because it dispatches via `spawn_blocking`.
/// This is intentional: calling into FFI/syscalls directly on the async executor thread
/// risks stalling the runtime on network-backed or otherwise slow filesystems (e.g. NFS).
#[napi]
pub async fn try_shared(
    fd: os::FileDescriptor,
    options: Option<NonBlockingOptions>,
) -> napi::Result<bool> {
    try_acquire(fd, Lock::Shared, options).await
}

/// Release a previously acquired lock.
#[napi]
pub fn unlock(fd: os::FileDescriptor, range: Option<LockRange>) -> napi::Result<()> {
    let range = range.map(try_into_os_range).transpose()?;
    os::file_lock(fd, Lock::Unlock, range).map_err(io_error)?;
    Ok(())
}

#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct BlockingOptions {
    pub poll_ms: Option<u32>,
    pub timeout: Option<u32>,
    pub range: Option<LockRange>,
}

#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct NonBlockingOptions {
    pub range: Option<LockRange>,
}

#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct LockRange {
    pub offset: i64,
    pub length: i64,
}

async fn acquire(
    fd: os::FileDescriptor,
    mode: Lock,
    options: Option<BlockingOptions>,
) -> napi::Result<()> {
    let range = options
        .and_then(|o| o.range)
        .map(try_into_os_range)
        .transpose()?;
    poll_lock(options, move || os::file_lock(fd, mode, range))
        .await
        .map(|_| {})
}

async fn try_acquire(
    fd: os::FileDescriptor,
    mode: Lock,
    options: Option<NonBlockingOptions>,
) -> napi::Result<bool> {
    let range = options
        .and_then(|o| o.range)
        .map(try_into_os_range)
        .transpose()?;
    tokio::task::spawn_blocking(move || os::file_lock(fd, mode, range))
        .await
        .map_err(task_error)?
        .map(|a| matches!(a, LockAttempt::Acquired))
        .map_err(io_error)
}

/// Poll a lock attempt in a loop with configurable interval and timeout.
async fn poll_lock(
    options: Option<BlockingOptions>,
    attempt_lock: impl Fn() -> std::io::Result<LockAttempt> + Send + Clone + 'static,
) -> napi::Result<()> {
    let poll_ms = options.as_ref().and_then(|o| o.poll_ms).unwrap_or(10) as u64;
    let timeout = options
        .as_ref()
        .and_then(|o| o.timeout)
        .map(|t| Duration::from_millis(t as u64));

    let poll = async {
        loop {
            let attempt = attempt_lock.clone();
            let locked = tokio::task::spawn_blocking(attempt)
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

pub fn try_into_os_range(range: LockRange) -> std::io::Result<(os::Offset, os::Length)> {
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
