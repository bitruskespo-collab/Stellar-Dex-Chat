//! Supported Network Compatibility Matrix
//! Addresses Issue #84: Verify contract and client assumptions against each documented Stellar network.

use soroban_sdk::{contracttype, String, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SupportedChain {
    Standalone,
    Testnet,
    Public,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkMatrixEntry {
    pub chain: SupportedChain,
    pub min_protocol_version: u32,
    pub passphrase_prefix: String,
    pub requires_oracle: bool,
    pub max_tx_timeout_seconds: u32,
}

pub fn get_network_entry(env: &Env, chain: SupportedChain) -> NetworkMatrixEntry {
    match chain {
        SupportedChain::Standalone => NetworkMatrixEntry {
            chain: SupportedChain::Standalone,
            min_protocol_version: 20,
            passphrase_prefix: String::from_str(env, "Standalone Network"),
            requires_oracle: false,
            max_tx_timeout_seconds: 30,
        },
        SupportedChain::Testnet => NetworkMatrixEntry {
            chain: SupportedChain::Testnet,
            min_protocol_version: 21,
            passphrase_prefix: String::from_str(env, "Test SDF Network"),
            requires_oracle: true,
            max_tx_timeout_seconds: 60,
        },
        SupportedChain::Public => NetworkMatrixEntry {
            chain: SupportedChain::Public,
            min_protocol_version: 21,
            passphrase_prefix: String::from_str(env, "Public Global Stellar Network"),
            requires_oracle: true,
            max_tx_timeout_seconds: 120,
        },
    }
}
