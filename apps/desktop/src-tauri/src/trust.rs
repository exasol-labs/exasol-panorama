//! Which database certificates this machine trusts, and how it got to.
//!
//! A browser refuses a `wss://` handshake to a host whose certificate it does not
//! trust and — unlike a page navigation — never offers to make an exception. That
//! is the right default for the web and it makes the most common local Exasol
//! unreachable: an Exasol Personal instance on this machine presents a
//! certificate it signed itself, and no amount of clicking in an application can
//! change that from inside the page.
//!
//! The desktop application can do what a browser cannot, because the socket is
//! opened out here. So the rule is:
//!
//! - **A certificate the system trusts is used with no ceremony.** Managed
//!   instances and Exasol SaaS never reach this file.
//! - **A certificate on this machine's loopback interface is trusted without
//!   asking.** Reaching 127.0.0.1 means talking to this computer; a certificate
//!   is not what stands between you and a program you are already running, and
//!   asking about it teaches people to click through the question that matters.
//! - **Anything else is a question for the person**, once, naming the fingerprint
//!   — and the answer is remembered per host and per certificate, so a
//!   certificate that changes asks again. This is trust on first use, which is
//!   what `ssh` does, for the same reason.
//!
//! Nothing here weakens verification silently: `Trust::Verified` and
//! `Trust::Remembered` are different answers, and the connection log says which
//! one a session got.

use std::collections::BTreeMap;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

/// How a certificate came to be acceptable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    /// The system's own trust store verified it. Nothing was asked or remembered.
    Verified,
    /// Loopback: this machine, talking to itself.
    Loopback,
    /// The person said yes to this exact certificate for this exact host.
    Remembered,
}

/// A certificate's SHA-256, in the form a person can compare with what their
/// database tells them: uppercase hex, colon-separated.
pub fn fingerprint(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Whether a host is this machine.
///
/// By name as well as by address, because `localhost` is what Exasol Personal's
/// own certificate is issued for and what a person types.
pub fn is_loopback(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.eq_ignore_ascii_case("localhost") || bare.to_ascii_lowercase().ends_with(".localhost") {
        return true;
    }
    match bare.parse::<std::net::IpAddr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => false,
    }
}

fn store_path() -> PathBuf {
    crate::session::sessions_dir()
        .parent()
        .map(|dir| dir.join("trusted-certificates.json"))
        .unwrap_or_else(|| PathBuf::from("trusted-certificates.json"))
}

/// `host:port` -> the fingerprints its certificate is allowed to have.
///
/// A list rather than one, so that an instance being reissued does not lock
/// somebody out of the one they are still using — and a map keyed by authority
/// rather than by host, because two ports on one machine can be two databases.
fn read() -> BTreeMap<String, Vec<String>> {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn remembered(authority: &str, fingerprint: &str) -> bool {
    read()
        .get(authority)
        .is_some_and(|known| known.iter().any(|entry| entry == fingerprint))
}

/// Writes a decision down. Best effort: a machine that cannot write it will ask
/// again next time, which is annoying and not wrong.
pub fn remember(authority: &str, fingerprint: &str) {
    let mut store = read();
    let known = store.entry(authority.to_string()).or_default();
    if !known.iter().any(|entry| entry == fingerprint) {
        known.push(fingerprint.to_string());
    }
    let path = store_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&store) {
        let _ = std::fs::write(path, format!("{text}\n"));
    }
}

/// What to say to the person, when it comes to that.
///
/// Written here rather than at the call site because it is the one text in the
/// application whose wording is a security decision: it has to be answerable by
/// somebody who did not expect to be asked, and it must not make "yes" sound like
/// the tidy option.
pub fn question(authority: &str, fingerprint: &str, subject: &str, issuer: &str) -> String {
    format!(
        "Panorama cannot verify the identity of {authority}.\n\n\
         The database presented a certificate that nothing on this machine vouches for. \
         That is normal for an instance whose certificate it signed itself, and it is also \
         what an intercepted connection looks like.\n\n\
         Subject: {subject}\nIssuer: {issuer}\nSHA-256: {fingerprint}\n\n\
         Connect and remember this certificate for {authority}?"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fingerprint_is_comparable_by_eye() {
        // The empty input's SHA-256, which is a well-known constant.
        let printed = fingerprint(&[]);
        assert!(printed.starts_with("E3:B0:C4:42:98:FC"));
        assert_eq!(printed.len(), 32 * 3 - 1);
    }

    #[test]
    fn knows_this_machine_by_name_and_by_number() {
        assert!(is_loopback("localhost"));
        assert!(is_loopback("LOCALHOST"));
        assert!(is_loopback("db.localhost"));
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.1.2.3"));
        assert!(is_loopback("[::1]"));
        assert!(!is_loopback("db.internal"));
        assert!(!is_loopback("192.168.0.10"));
        // The one that matters: a name that merely *contains* localhost is not it.
        assert!(!is_loopback("localhost.evil.example"));
    }

    #[test]
    fn remembers_a_decision_per_host_and_per_certificate() {
        crate::session::with_own_session_dir("trust", || {
            assert!(!remembered("db.internal:8563", "AA:BB"));
            remember("db.internal:8563", "AA:BB");
            assert!(remembered("db.internal:8563", "AA:BB"));
            // A different certificate on the same host is a different question.
            assert!(!remembered("db.internal:8563", "CC:DD"));
            // And the same certificate on a different port is too.
            assert!(!remembered("db.internal:9563", "AA:BB"));
            // Remembering twice does not grow the file.
            remember("db.internal:8563", "AA:BB");
            assert_eq!(read().get("db.internal:8563").map(Vec::len), Some(1));
        });
    }

    #[test]
    fn the_question_names_what_it_is_asking_about() {
        let asked = question("db.internal:8563", "AA:BB:CC", "CN=db", "CN=db");
        assert!(asked.contains("db.internal:8563"));
        assert!(asked.contains("AA:BB:CC"));
        // It says what the other explanation is, rather than only the benign one.
        assert!(asked.contains("intercepted"));
    }
}
