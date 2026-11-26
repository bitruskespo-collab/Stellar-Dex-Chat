use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

/// Interface that any price oracle contract must implement.
/// Returns the price of a token in USD with 7 decimal places
/// (i.e. 1 USD = 10_000_000).
#[contractclient(name = "OracleClient")]
pub trait PriceOracle {
    fn get_price(env: Env, token: Address) -> Option<i128>;
}

/// Extended oracle interface used by operations that need a freshness and
/// confidence check. Keeping this separate preserves the legacy price-only ABI.
#[contractclient(name = "ObservationOracleClient")]
pub trait ObservationOracle {
    fn get_observation(env: Env, token: Address) -> Option<OracleObservation>;
}

/// Versioned source interface consumed by [`OracleAdapter`].
#[contractclient(name = "VersionedOracleSourceClient")]
pub trait VersionedOracleSource {
    fn get_observation(env: Env, token: Address) -> Option<VersionedOracleObservation>;
}

/// A version-1 feed observation. Prices are normalized by the adapter to
/// `ORACLE_PRICE_DECIMALS` before aggregation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VersionedOracleObservation {
    pub version: u32,
    pub price: i128,
    pub price_decimals: u32,
    pub recorded_at: u32,
    pub confidence: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleAdapterConfig {
    pub max_age_ledgers: u32,
    pub min_confidence: i128,
    pub min_sources: u32,
    pub max_spread_bps: u32,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleAdapterError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidConfig = 4,
    UnsupportedVersion = 5,
    InvalidObservation = 6,
    TooFewSources = 7,
    SpreadTooWide = 8,
    ArithmeticOverflow = 9,
}

#[contracttype]
enum AdapterKey {
    Admin,
    Sources,
    Config,
}

/// Aggregates versioned feeds and implements the simple `PriceOracle`
/// interface consumed by FiatBridge.
#[contract]
pub struct OracleAdapter;

#[contractimpl]
impl OracleAdapter {
    pub fn init(
        env: Env,
        admin: Address,
        sources: Vec<Address>,
        config: OracleAdapterConfig,
    ) -> Result<(), OracleAdapterError> {
        if env.storage().instance().has(&AdapterKey::Admin) {
            return Err(OracleAdapterError::AlreadyInitialized);
        }
        Self::validate_config(&sources, &config)?;
        admin.require_auth();
        env.storage().instance().set(&AdapterKey::Admin, &admin);
        env.storage().instance().set(&AdapterKey::Sources, &sources);
        env.storage().instance().set(&AdapterKey::Config, &config);
        Ok(())
    }

    pub fn set_sources(
        env: Env,
        admin: Address,
        sources: Vec<Address>,
    ) -> Result<(), OracleAdapterError> {
        Self::require_admin(&env, &admin)?;
        let config: OracleAdapterConfig = env
            .storage()
            .instance()
            .get(&AdapterKey::Config)
            .ok_or(OracleAdapterError::NotInitialized)?;
        Self::validate_config(&sources, &config)?;
        env.storage().instance().set(&AdapterKey::Sources, &sources);
        Ok(())
    }

    pub fn set_config(
        env: Env,
        admin: Address,
        config: OracleAdapterConfig,
    ) -> Result<(), OracleAdapterError> {
        Self::require_admin(&env, &admin)?;
        let sources: Vec<Address> = env
            .storage()
            .instance()
            .get(&AdapterKey::Sources)
            .ok_or(OracleAdapterError::NotInitialized)?;
        Self::validate_config(&sources, &config)?;
        env.storage().instance().set(&AdapterKey::Config, &config);
        Ok(())
    }

    pub fn get_config(env: Env) -> Result<OracleAdapterConfig, OracleAdapterError> {
        env.storage()
            .instance()
            .get(&AdapterKey::Config)
            .ok_or(OracleAdapterError::NotInitialized)
    }

    /// Compatibility interface: invalid or unavailable aggregated prices are
    /// represented as `None`. Integrators needing the specific failure cause
    /// can call `get_aggregated_price`.
    pub fn get_price(env: Env, token: Address) -> Option<i128> {
        Self::get_aggregated_price(env, token).ok()
    }

    pub fn get_aggregated_price(
        env: Env,
        token: Address,
    ) -> Result<i128, OracleAdapterError> {
        let sources: Vec<Address> = env
            .storage()
            .instance()
            .get(&AdapterKey::Sources)
            .ok_or(OracleAdapterError::NotInitialized)?;
        let config: OracleAdapterConfig = env
            .storage()
            .instance()
            .get(&AdapterKey::Config)
            .ok_or(OracleAdapterError::NotInitialized)?;
        let current_ledger = env.ledger().sequence();
        let mut prices = Vec::new(&env);

        for source in sources.iter() {
            let observation = match VersionedOracleSourceClient::new(&env, &source)
                .try_get_observation(&token)
            {
                Ok(Ok(observation)) => observation,
                _ => return Err(OracleAdapterError::InvalidObservation),
            };
            let Some(observation) = observation else {
                continue;
            };
            if observation.version != 1 {
                return Err(OracleAdapterError::UnsupportedVersion);
            }
            if observation.price <= 0
                || observation.price_decimals > 18
                || observation.confidence < config.min_confidence
                || observation.recorded_at > current_ledger
                || current_ledger.saturating_sub(observation.recorded_at)
                    > config.max_age_ledgers
            {
                continue;
            }
            let normalized =
                Self::normalize_price(observation.price, observation.price_decimals)
                    .ok_or(OracleAdapterError::ArithmeticOverflow)?;
            if normalized > 0 {
                let price = normalized;
                prices.push_back(price);
            }
        }

        if prices.len() < config.min_sources {
            return Err(OracleAdapterError::TooFewSources);
        }
        let min = prices.iter().min().ok_or(OracleAdapterError::TooFewSources)?;
        let max = prices.iter().max().ok_or(OracleAdapterError::TooFewSources)?;
        let spread_numerator = max
            .checked_sub(min)
            .and_then(|difference| difference.checked_mul(10_000))
            .ok_or(OracleAdapterError::ArithmeticOverflow)?;
        let spread_limit = min
            .checked_mul(config.max_spread_bps as i128)
            .ok_or(OracleAdapterError::ArithmeticOverflow)?;
        if spread_numerator > spread_limit {
            return Err(OracleAdapterError::SpreadTooWide);
        }

        let middle = prices.len() / 2;
        let upper = Self::order_statistic(&prices, middle)
            .ok_or(OracleAdapterError::InvalidObservation)?;
        if prices.len() % 2 == 1 {
            Ok(upper)
        } else {
            let lower = Self::order_statistic(&prices, middle - 1)
                .ok_or(OracleAdapterError::InvalidObservation)?;
            lower
                .checked_add((upper - lower) / 2)
                .ok_or(OracleAdapterError::ArithmeticOverflow)
        }
    }
}

impl OracleAdapter {
    const MAX_SOURCES: u32 = 9;
    const ORACLE_PRICE_DECIMALS: u32 = 7;

    fn require_admin(env: &Env, caller: &Address) -> Result<(), OracleAdapterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&AdapterKey::Admin)
            .ok_or(OracleAdapterError::NotInitialized)?;
        if &admin != caller {
            return Err(OracleAdapterError::Unauthorized);
        }
        caller.require_auth();
        Ok(())
    }

    fn validate_config(
        sources: &Vec<Address>,
        config: &OracleAdapterConfig,
    ) -> Result<(), OracleAdapterError> {
        if sources.is_empty()
            || sources.len() > Self::MAX_SOURCES
            || config.min_sources == 0
            || config.min_sources > sources.len()
            || config.max_age_ledgers == 0
            || config.min_confidence < 0
            || config.max_spread_bps > 10_000
        {
            return Err(OracleAdapterError::InvalidConfig);
        }
        for (index, source) in sources.iter().enumerate() {
            for other in sources.iter().skip(index + 1) {
                if source == other {
                    return Err(OracleAdapterError::InvalidConfig);
                }
            }
        }
        Ok(())
    }

    fn normalize_price(price: i128, decimals: u32) -> Option<i128> {
        match decimals.cmp(&Self::ORACLE_PRICE_DECIMALS) {
            core::cmp::Ordering::Equal => Some(price),
            core::cmp::Ordering::Less => {
                let factor = 10_i128.checked_pow(Self::ORACLE_PRICE_DECIMALS - decimals)?;
                price.checked_mul(factor)
            }
            core::cmp::Ordering::Greater => {
                let factor = 10_i128.checked_pow(decimals - Self::ORACLE_PRICE_DECIMALS)?;
                Some(price / factor)
            }
        }
    }

    fn order_statistic(prices: &Vec<i128>, rank: u32) -> Option<i128> {
        for candidate in prices.iter() {
            let mut less = 0;
            let mut equal = 0;
            for value in prices.iter() {
                if value < candidate {
                    less += 1;
                } else if value == candidate {
                    equal += 1;
                }
            }
            if rank >= less && rank < less + equal {
                return Some(candidate);
            }
        }
        None
    }
}

/// A price value tagged with the ledger sequence at which it was recorded.
/// Used by oracle staleness tests.
pub struct TimestampedPrice {
    /// Price in USD with 7 decimal places (e.g. 10_000_000 = $1.00).
    pub price: i128,
    /// The ledger sequence number at which this price was recorded.
    pub recorded_at: u32,
}

impl TimestampedPrice {
    /// Returns `true` if `current_ledger - recorded_at <= max_age_ledgers`.
    /// Saturates to 0 if `current_ledger < recorded_at` (clock skew guard).
    pub fn is_fresh(&self, current_ledger: u32, max_age_ledgers: u32) -> bool {
        let age = current_ledger.saturating_sub(self.recorded_at);
        age <= max_age_ledgers
    }
}

/// Per-oracle freshness and confidence configuration.
///
/// `max_age_ledgers` is the maximum number of ledgers an observation may lag
/// behind the current ledger before it is considered stale.
/// `min_confidence` is the minimum confidence (in the oracle's own scale) an
/// observation must report to be accepted.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfig {
    pub max_age_ledgers: u32,
    pub min_confidence: i128,
}

impl OracleConfig {
    /// Conservative default: observations must be at most 5 ledgers old and
    /// report a confidence of at least 1.
    pub const fn default() -> Self {
        Self {
            max_age_ledgers: 5,
            min_confidence: 1,
        }
    }
}

/// A single price observation returned by an oracle.
///
/// The `price` payload is untrusted and must never be persisted or emitted in
/// diagnostic events; only the oracle identity and observed ledger are safe to
/// surface.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleObservation {
    /// Price in USD with 7 decimal places (e.g. 10_000_000 = $1.00).
    pub price: i128,
    /// The ledger sequence number at which this observation was recorded.
    pub recorded_at: u32,
    /// Confidence reported by the oracle, in the oracle's own scale.
    pub confidence: i128,
}

/// Distinct errors for invalid oracle observations.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    /// No observation was returned by the oracle.
    OracleMissing = 1,
    /// The observation is older than the configured maximum age.
    OracleStale = 2,
    /// The observation is dated in the future relative to the current ledger.
    OracleFutureDated = 3,
    /// The observation's confidence is below the configured threshold.
    OracleLowConfidence = 4,
    /// The oracle contract could not be invoked or its response could not be decoded.
    OracleUnavailable = 5,
    /// The oracle reported a non-positive price.
    OraclePriceInvalid = 6,
}

/// Topic used for oracle diagnostic events.
const ORACLE_DIAG_TOPIC: &str = "oracle_diag";

/// Validates an oracle observation against the supplied configuration.
///
/// Classifies, in order:
/// - a missing observation (`None`) as [`OracleError::OracleMissing`],
/// - a non-positive price as [`OracleError::OraclePriceInvalid`],
/// - a future-dated observation (`recorded_at > current_ledger`) as
///   [`OracleError::OracleFutureDated`],
/// - a stale observation (`age > max_age_ledgers`) as
///   [`OracleError::OracleStale`],
/// - a below-confidence observation (`confidence < min_confidence`) as
///   [`OracleError::OracleLowConfidence`].
/// Invocation and response-decoding failures are handled as
/// [`OracleError::OracleUnavailable`] by the caller.
///
/// On success, emits a diagnostic event carrying only the oracle identity, the
/// observed ledger, and the current ledger. The untrusted price payload is
/// never emitted or stored.
pub fn validate_observation(
    env: &Env,
    oracle_id: &Address,
    observation: Option<OracleObservation>,
    config: &OracleConfig,
    current_ledger: u32,
) -> Result<OracleObservation, OracleError> {
    let observation = match observation {
        Some(obs) => obs,
        None => {
            emit_diagnostic(env, oracle_id, None, current_ledger);
            return Err(OracleError::OracleMissing);
        }
    };

    if observation.price <= 0 {
        emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
        return Err(OracleError::OraclePriceInvalid);
    }

    // Future-dated observations are rejected before staleness so that clock
    // skew cannot be masked by saturating subtraction.
    if observation.recorded_at > current_ledger {
        emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
        return Err(OracleError::OracleFutureDated);
    }

    let age = current_ledger.saturating_sub(observation.recorded_at);
    if age > config.max_age_ledgers {
        emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
        return Err(OracleError::OracleStale);
    }

    if observation.confidence < config.min_confidence {
        emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
        return Err(OracleError::OracleLowConfidence);
    }

    emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
    Ok(observation)
}

/// Emits a diagnostic event with only safe metadata: the oracle identity, the
/// observed ledger (if any), and the current ledger. Never includes the price
/// payload.
fn emit_diagnostic(
    env: &Env,
    oracle_id: &Address,
    observed_at: Option<u32>,
    current_ledger: u32,
) {
    let observed = observed_at.unwrap_or(0);
    #[allow(deprecated)]
    env.events().publish(
        (Symbol::new(env, ORACLE_DIAG_TOPIC), oracle_id.clone()),
        (observed, current_ledger),
    );
}

/// Record a failed oracle invocation without exposing a price payload.
pub(crate) fn emit_unavailable_diagnostic(
    env: &Env,
    oracle_id: &Address,
    current_ledger: u32,
) {
    emit_diagnostic(env, oracle_id, None, current_ledger);
}