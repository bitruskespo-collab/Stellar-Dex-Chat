#![cfg(test)]

use crate::{token, Address, Bytes, Env, Error, FiatBridge, FiatBridgeClient};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    vec,
};

fn create_token_contract<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, token::Client<'a>, token::StellarAssetClient<'a>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    (
        sac.address(),
        token::Client::new(env, &sac.address()),
        token::StellarAssetClient::new(env, &sac.address()),
    )
}

// ── Mock Oracle ─────────────────────────────────────────────────────────────
#[contract]
pub struct MockPriceOracle;

#[contractimpl]
impl MockPriceOracle {
    pub fn set_price(env: Env, token: Address, price: i128) {
        env.storage().instance().set(&token, &price);
    }

    pub fn get_price(env: Env, token: Address) -> Option<i128> {
        env.storage().instance().get(&token)
    }
}

// ── Adversarial Token: Fee-on-Transfer / Short Transfer ─────────────────────
#[contract]
pub struct AdversarialShortToken;

#[contractimpl]
impl AdversarialShortToken {
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().instance().get(&id).unwrap_or(0)
    }

    pub fn set_balance(env: Env, id: Address, amount: i128) {
        env.storage().instance().set(&id, &amount);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        // Delivers amount - 5 units (short transfer / fee-on-transfer)
        let delivered = (amount - 5).max(0);
        let from_bal = Self::balance(env.clone(), from.clone());
        let to_bal = Self::balance(env.clone(), to.clone());
        env.storage().instance().set(&from, &(from_bal - amount));
        env.storage().instance().set(&to, &(to_bal + delivered));
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }
}

// ── Adversarial Token: Mismatch Balance Delta ───────────────────────────────
#[contract]
pub struct AdversarialMismatchToken;

#[contractimpl]
impl AdversarialMismatchToken {
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().instance().get(&id).unwrap_or(0)
    }

    pub fn set_balance(env: Env, id: Address, amount: i128) {
        env.storage().instance().set(&id, &amount);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        // Delivers amount + 5 units (corrupted delta)
        let delivered = amount + 5;
        let from_bal = Self::balance(env.clone(), from.clone());
        let to_bal = Self::balance(env.clone(), to.clone());
        env.storage().instance().set(&from, &(from_bal - amount));
        env.storage().instance().set(&to, &(to_bal + delivered));
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }
}

// ── Test Setup Helper ───────────────────────────────────────────────────────
fn setup_test_env(
    env: &Env,
) -> (
    Address,
    FiatBridgeClient<'_>,
    Address,
    Address,
    token::Client<'_>,
    token::StellarAssetClient<'_>,
) {
    env.mock_all_auths();
    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let (token_addr, token_client, token_sac) = create_token_contract(env, &token_admin);
    let signers = vec![env, admin.clone()];
    bridge.init(&admin, &token_addr, &1_000_000_000, &1, &signers, &1, &0);
    (
        contract_id,
        bridge,
        admin,
        token_addr,
        token_client,
        token_sac,
    )
}

// ============================================================================
// ISSUE #23: Rolling Fiat-Volume Caps with Explicit Window Semantics
// ============================================================================

#[test]
fn test_fiat_caps_user_and_global_limits_around_boundaries() {
    let env = Env::default();
    let (_, bridge, _, token_addr, _, token_sac) = setup_test_env(&env);

    let oracle_id = env.register(MockPriceOracle, ());
    let oracle = MockPriceOracleClient::new(&env, &oracle_id);
    // Price = $1.00 (10_000_000 fixed point)
    oracle.set_price(&token_addr, &10_000_000);
    bridge.set_oracle(&oracle_id);

    // Set user cap to $10.00 (1,000 cents), global cap to $15.00 (1,500 cents)
    bridge.set_fiat_limit(&1_000);
    bridge.set_global_fiat_limit(&1_500);

    assert_eq!(bridge.get_fiat_limit(), Some(1_000));
    assert_eq!(bridge.get_global_fiat_limit(), Some(1_500));

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    // 1 token = 10^7 stroops = $1.00 = 100 cents
    token_sac.mint(&user1, &200_000_000);
    token_sac.mint(&user2, &200_000_000);

    // User 1 deposits 9.99 tokens = 999 cents (cap - 1)
    let res = bridge.try_deposit(
        &user1,
        &99_900_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert!(res.is_ok());
    assert_eq!(bridge.get_user_fiat_volume(&user1), 999);
    assert_eq!(bridge.get_global_fiat_volume(), 999);

    // User 1 deposits 0.01 tokens = 1 cent (hitting user cap exactly: 1000 cents)
    let res = bridge.try_deposit(
        &user1,
        &100_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert!(res.is_ok());
    assert_eq!(bridge.get_user_fiat_volume(&user1), 1000);
    assert_eq!(bridge.get_global_fiat_volume(), 1000);

    // User 1 deposits 0.01 tokens (cap + 1) -> Exceeds user cap
    let res = bridge.try_deposit(
        &user1,
        &100_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::ExceedsFiatLimit)));

    // User 2 deposits 5.00 tokens = 500 cents (hits global cap: 1000 + 500 = 1500)
    let res = bridge.try_deposit(
        &user2,
        &50_000_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert!(res.is_ok());
    assert_eq!(bridge.get_user_fiat_volume(&user2), 500);
    assert_eq!(bridge.get_global_fiat_volume(), 1500);

    // User 2 attempts another 0.01 tokens -> Exceeds global cap even though user2 has room!
    let res = bridge.try_deposit(
        &user2,
        &100_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::ExceedsFiatLimit)));
}

#[test]
fn test_fiat_rolling_window_semantics_and_edges() {
    let env = Env::default();
    let (_, bridge, _, token_addr, _, token_sac) = setup_test_env(&env);

    let oracle_id = env.register(MockPriceOracle, ());
    let oracle = MockPriceOracleClient::new(&env, &oracle_id);
    oracle.set_price(&token_addr, &10_000_000);
    bridge.set_oracle(&oracle_id);

    // Configure rolling window to 500 ledgers
    bridge.set_fiat_window(&500);
    assert_eq!(bridge.get_fiat_window(), 500);

    bridge.set_fiat_limit(&1_000); // 1000 cents ($10.00)

    let user = Address::generate(&env);
    token_sac.mint(&user, &500_000_000);

    // Sequence = 100
    env.ledger().with_mut(|l| l.sequence_number = 100);

    // Deposit full cap of $10.00 (1000 cents)
    bridge.deposit(
        &user,
        &100_000_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(bridge.get_user_fiat_volume(&user), 1000);

    // At sequence 599 (window edge: 100 + 500 - 1 = 599), cap is still consumed
    env.ledger().with_mut(|l| l.sequence_number = 599);
    assert_eq!(bridge.get_user_fiat_volume(&user), 1000);
    let res = bridge.try_deposit(
        &user,
        &100_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::ExceedsFiatLimit)));

    // At sequence 600 (window has elapsed: 100 + 500 = 600), quota resets
    env.ledger().with_mut(|l| l.sequence_number = 600);
    assert_eq!(bridge.get_user_fiat_volume(&user), 0);

    // Deposit succeeds in new rolling window
    let res = bridge.try_deposit(
        &user,
        &50_000_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert!(res.is_ok());
    assert_eq!(bridge.get_user_fiat_volume(&user), 500);
}

#[test]
fn test_price_observation_time_freezes_consumed_quota() {
    let env = Env::default();
    let (_, bridge, _, token_addr, _, token_sac) = setup_test_env(&env);

    let oracle_id = env.register(MockPriceOracle, ());
    let oracle = MockPriceOracleClient::new(&env, &oracle_id);
    // Initial price: $1.00
    oracle.set_price(&token_addr, &10_000_000);
    bridge.set_oracle(&oracle_id);

    bridge.set_fiat_limit(&1_000); // 1000 cents ($10.00)

    let user = Address::generate(&env);
    token_sac.mint(&user, &50_000_000);

    // Deposit 5 tokens at $1.00 = 500 cents
    bridge.deposit(
        &user,
        &50_000_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(bridge.get_user_fiat_volume(&user), 500);

    // Oracle price crashes to $0.10 or skyrockets to $100.00
    oracle.set_price(&token_addr, &1_000_000_000); // $100.00

    // Stored quota MUST NOT change retroactively
    assert_eq!(bridge.get_user_fiat_volume(&user), 500);
}

#[test]
fn test_mixed_tokens_precision_normalized_against_caps() {
    let env = Env::default();
    let (_, bridge, _, token7, _, token7_sac) = setup_test_env(&env);

    // Register second token with 6 decimals (e.g. USDC)
    let token6_admin = Address::generate(&env);
    let (token6, _, token6_sac) = create_token_contract(&env, &token6_admin);
    bridge.register_token(&token6, &1_000_000_000, &6);
    assert_eq!(bridge.get_token_precision(&token6), 6);

    let oracle_id = env.register(MockPriceOracle, ());
    let oracle = MockPriceOracleClient::new(&env, &oracle_id);
    oracle.set_price(&token7, &10_000_000); // Token7 = $1.00
    oracle.set_price(&token6, &20_000_000); // Token6 = $2.00
    bridge.set_oracle(&oracle_id);

    bridge.set_fiat_limit(&1_000); // $10.00 = 1000 cents

    let user = Address::generate(&env);
    token7_sac.mint(&user, &100_000_000);
    token6_sac.mint(&user, &100_000_000);

    // Deposit 4 Token7 (7 decimals: 4 * 10^7 at $1.00 = $4.00 = 400 cents)
    bridge.deposit(
        &user,
        &40_000_000,
        &token7,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(bridge.get_user_fiat_volume(&user), 400);

    // Deposit 3 Token6 (6 decimals: 3 * 10^6 at $2.00 = $6.00 = 600 cents)
    bridge.deposit(
        &user,
        &3_000_000,
        &token6,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    // Total should be exactly 1000 cents (cap reached)
    assert_eq!(bridge.get_user_fiat_volume(&user), 1000);

    // Further deposit of either token must fail
    let res = bridge.try_deposit(
        &user,
        &100_000,
        &token7,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::ExceedsFiatLimit)));
}

#[test]
fn test_stale_or_invalid_oracle_prices_rejected() {
    let env = Env::default();
    let (_, bridge, _, token_addr, _, token_sac) = setup_test_env(&env);

    bridge.set_fiat_limit(&1_000);
    let user = Address::generate(&env);
    token_sac.mint(&user, &10_000_000);

    // No oracle set
    let res = bridge.try_deposit(
        &user,
        &1_000_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::OracleNotSet)));

    // Set oracle returning invalid/zero price
    let oracle_id = env.register(MockPriceOracle, ());
    let oracle = MockPriceOracleClient::new(&env, &oracle_id);
    oracle.set_price(&token_addr, &0);
    bridge.set_oracle(&oracle_id);

    let res = bridge.try_deposit(
        &user,
        &1_000_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &10_000,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::OraclePriceInvalid)));
}

// ============================================================================
// ISSUE #24: Fee Accrual Rounding Conserves Token Units
// ============================================================================

#[test]
fn test_fee_conservation_single_transfer() {
    let env = Env::default();
    let (_, bridge, _, token_addr, _, token_sac) = setup_test_env(&env);

    // Configure 250 bps = 2.5% fee
    bridge.set_fee_bps(&250);
    assert_eq!(bridge.get_fee_bps(), 250);

    let user = Address::generate(&env);
    token_sac.mint(&user, &10_000);

    // Deposit 1,000 units: fee = 1000 * 250 / 10000 = 25 units, net = 975 units
    bridge.deposit(&user, &1_000, &token_addr, &Bytes::new(&env), &0, &0, &None);
    let receipt = bridge.get_receipt_by_index(&0).unwrap();

    assert_eq!(receipt.amount, 975);
    assert_eq!(bridge.get_accrued_fees(&token_addr), 25);
    assert_eq!(bridge.get_fee_remainder(&token_addr), 0);

    let acct = bridge.get_fee_accounting(&token_addr);
    assert_eq!(acct.total_gross, 1000);
    assert_eq!(acct.total_net, 975);
    assert_eq!(acct.accrued_fees, 25);
    assert_eq!(acct.remainder, 0);
    assert_eq!(acct.total_gross, acct.total_net + acct.accrued_fees);
}

#[test]
fn test_fee_remainder_accumulator_repeated_small_transfers() {
    let env = Env::default();
    let (_, bridge, _, token_addr, _, token_sac) = setup_test_env(&env);

    // Configure 100 bps = 1.0%
    bridge.set_fee_bps(&100);

    let user = Address::generate(&env);
    token_sac.mint(&user, &1_000_000);

    let mut sum_net = 0i128;
    for i in 0..100 {
        bridge.deposit(&user, &33, &token_addr, &Bytes::new(&env), &0, &0, &None);
        let r = bridge.get_receipt_by_index(&i).unwrap();
        sum_net += r.amount;
    }

    let accrued = bridge.get_accrued_fees(&token_addr);
    let rem = bridge.get_fee_remainder(&token_addr);
    let acct = bridge.get_fee_accounting(&token_addr);

    // Exact conservation: total_gross == sum_net + accrued
    assert_eq!(acct.total_gross, 3300);
    assert_eq!(acct.total_net, sum_net);
    assert_eq!(accrued, 33);
    assert_eq!(rem, 0);
    assert_eq!(acct.total_gross, acct.total_net + accrued);
    assert_eq!(acct.total_gross * 100, accrued * 10_000 + rem);
}

#[test]
fn test_property_fee_conservation_reference_model() {
    let env = Env::default();
    let (_, bridge, _, token_addr, _, token_sac) = setup_test_env(&env);

    let bps = 350u32; // 3.5%
    bridge.set_fee_bps(&bps);

    let user = Address::generate(&env);
    token_sac.mint(&user, &10_000_000);

    let amounts: [i128; 20] = [
        1, 7, 13, 25, 42, 99, 103, 250, 7, 18, 5, 2, 88, 14, 301, 77, 12, 45, 9, 64,
    ];

    let mut ref_gross = 0i128;
    let mut ref_net = 0i128;
    let mut ref_fee = 0i128;
    let mut ref_rem = 0i128;

    for (i, &amount) in amounts.iter().enumerate() {
        // High-precision reference model calculation:
        let total_num = (amount * bps as i128) + ref_rem;
        let expected_fee = total_num / 10_000;
        let expected_rem = total_num % 10_000;
        let expected_net = amount - expected_fee;

        ref_gross += amount;
        ref_net += expected_net;
        ref_fee += expected_fee;
        ref_rem = expected_rem;

        // Invariant for each transfer:
        assert_eq!(amount, expected_net + expected_fee);

        bridge.deposit(
            &user,
            &amount,
            &token_addr,
            &Bytes::new(&env),
            &0,
            &0,
            &None,
        );
        let receipt = bridge.get_receipt_by_index(&(i as u64)).unwrap();
        assert_eq!(receipt.amount, expected_net);
    }

    let acct = bridge.get_fee_accounting(&token_addr);
    assert_eq!(acct.total_gross, ref_gross);
    assert_eq!(acct.total_net, ref_net);
    assert_eq!(acct.accrued_fees, ref_fee);
    assert_eq!(acct.remainder, ref_rem);

    // Multi-transfer conservation:
    assert_eq!(ref_gross, ref_net + ref_fee);
    assert_eq!(ref_gross * bps as i128, ref_fee * 10_000 + ref_rem);
    // Rate bound: accrued fees never exceed configured rate:
    assert!(ref_fee * 10_000 <= ref_gross * bps as i128);
}

// ============================================================================
// ISSUE #26: Token Precision Explicit Validated Registry Field
// ============================================================================

#[test]
fn test_token_precision_registration_bounds_and_silent_change_prevention() {
    let env = Env::default();
    let (_, bridge, _, _, _, _) = setup_test_env(&env);

    let token_admin = Address::generate(&env);

    // Supported bounds: decimals in 0..=18
    let (t0, _, _) = create_token_contract(&env, &token_admin);
    assert!(bridge.try_register_token(&t0, &100_000, &0).is_ok());
    assert_eq!(bridge.get_token_precision(&t0), 0);

    let (t6, _, _) = create_token_contract(&env, &token_admin);
    assert!(bridge.try_register_token(&t6, &100_000, &6).is_ok());
    assert_eq!(bridge.get_token_precision(&t6), 6);

    let (t18, _, _) = create_token_contract(&env, &token_admin);
    assert!(bridge.try_register_token(&t18, &100_000, &18).is_ok());
    assert_eq!(bridge.get_token_precision(&t18), 18);

    // Unsupported precision > 18 rejected
    let (t19, _, _) = create_token_contract(&env, &token_admin);
    assert_eq!(
        bridge.try_register_token(&t19, &100_000, &19),
        Err(Ok(Error::InvalidAmount))
    );

    // Prevent silent changes after use
    let (t_used, _, t_sac) = create_token_contract(&env, &token_admin);
    bridge.register_token(&t_used, &100_000, &6);

    let user = Address::generate(&env);
    t_sac.mint(&user, &10_000);
    bridge.deposit(&user, &5_000, &t_used, &Bytes::new(&env), &0, &0, &None);

    // Token has been used (total_deposited > 0) -> Re-registering must fail!
    assert_eq!(
        bridge.try_register_token(&t_used, &100_000, &8),
        Err(Ok(Error::AlreadyInitialized))
    );

    // Migrating precision after use must also fail!
    assert_eq!(
        bridge.try_migrate_token_precision(&t_used, &8),
        Err(Ok(Error::MigrationAlreadyComplete))
    );
}

#[test]
fn test_token_precision_migration_path() {
    let env = Env::default();
    let (_, bridge, _, initial_token, _, _) = setup_test_env(&env);

    // Initial token was registered in init, defaults to 7
    assert_eq!(bridge.get_token_precision(&initial_token), 7);

    // Migration path: before use, admin migrates precision
    let res = bridge.try_migrate_token_precision(&initial_token, &6);
    assert!(res.is_ok());
    assert_eq!(bridge.get_token_precision(&initial_token), 6);

    // Invalid precision migration rejected
    assert_eq!(
        bridge.try_migrate_token_precision(&initial_token, &20),
        Err(Ok(Error::InvalidAmount))
    );
}

// ============================================================================
// ISSUE #25: Validate Token Transfer Behavior for Non-Standard Assets
// ============================================================================

#[test]
fn test_adversarial_short_transfer_rejected_on_deposit() {
    let env = Env::default();
    let (_, bridge, _, _, _, _) = setup_test_env(&env);

    let short_token_id = env.register(AdversarialShortToken, ());
    let short_client = AdversarialShortTokenClient::new(&env, &short_token_id);

    // Register adversarial token
    bridge.register_token(&short_token_id, &100_000, &7);

    let user = Address::generate(&env);
    short_client.set_balance(&user, &10_000);

    // Attempt deposit: short transfer delivers amount - 5
    let res = bridge.try_deposit(
        &user,
        &1_000,
        &short_token_id,
        &Bytes::new(&env),
        &0,
        &0,
        &None,
    );
    // Contract must detect short transfer and reject with Error::ShortTransfer
    assert_eq!(res, Err(Ok(Error::ShortTransfer)));

    // State updates must NOT have occurred (atomic revert)
    assert_eq!(bridge.get_total_deposited(), 0);
}

#[test]
fn test_adversarial_mismatch_delta_rejected_on_deposit() {
    let env = Env::default();
    let (_, bridge, _, _, _, _) = setup_test_env(&env);

    let mismatch_token_id = env.register(AdversarialMismatchToken, ());
    let mismatch_client = AdversarialMismatchTokenClient::new(&env, &mismatch_token_id);

    bridge.register_token(&mismatch_token_id, &100_000, &7);

    let user = Address::generate(&env);
    mismatch_client.set_balance(&user, &10_000);

    // Attempt deposit: mismatch delivers amount + 5
    let res = bridge.try_deposit(
        &user,
        &1_000,
        &mismatch_token_id,
        &Bytes::new(&env),
        &0,
        &0,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::TransferFailed)));

    assert_eq!(bridge.get_total_deposited(), 0);
}

#[test]
fn test_adversarial_short_transfer_rejected_on_withdraw() {
    let env = Env::default();
    let (contract_id, bridge, admin, _, _, _) = setup_test_env(&env);

    let short_token_id = env.register(AdversarialShortToken, ());
    let short_client = AdversarialShortTokenClient::new(&env, &short_token_id);

    bridge.register_token(&short_token_id, &100_000, &7);

    // Fund the contract with token balance
    short_client.set_balance(&contract_id, &50_000);

    let recipient = Address::generate(&env);

    // Attempt withdraw: short token transfers amount - 5
    let res = bridge.try_withdraw(&admin, &recipient, &1_000, &short_token_id);
    assert_eq!(res, Err(Ok(Error::ShortTransfer)));
}
