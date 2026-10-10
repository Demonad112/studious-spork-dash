//! Errors for the agent layer.

use std::fmt;

/// Everything that can go wrong in the agent layer.
#[derive(Debug)]
pub enum Error {
    /// Remote control is switched off in the configuration.
    Disabled,
    /// The configuration is not usable. The text names the field.
    InvalidConfig(String),
    /// A file operation failed.
    Io(std::io::Error),
    /// A secret store could not read or write.
    Secret(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Disabled => write!(f, "remote control is disabled"),
            Error::InvalidConfig(what) => write!(f, "invalid configuration: {what}"),
            Error::Io(e) => write!(f, "io error: {}", e.kind()),
            Error::Secret(what) => write!(f, "secret store error: {what}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

/// Result alias for the agent layer.
pub type Result<T> = std::result::Result<T, Error>;
