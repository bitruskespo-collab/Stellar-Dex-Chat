//! Regression tests for multisig proposal expiry and bounded cleanup (#175).
//!
//! Policy under test:
//! * A proposal expires at `created_at + get_multisig_expiry()`.
//! * `prune_expired_multisig_proposals` removes only expired, unexecuted
//!   proposals and emits one `multisig_expired` event per removal.
//! * Executed proposals and proposals still inside their window are untouched.
//! * An expired proposal can no longer execute.
//! * Only the admin may run cleanup, and each call scans a bounded number of
//!   proposal IDs.

use crate::{BatchAdminOp, Error, FiatBridge, FiatBridgeClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    Address, Bytes, Env, Symbol, Vec,
};

const EXPIRY_WINDOW: u32 = 10;

fn setup<'a>(env: &Env, signer_count: u32) -> (FiatBridgeClient<'a>, Vec<Address>, Address) {
    let admin = Address::generate(env);
    let token_address = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(FiatBridge, ());
    let client = FiatBridgeClient::new(env, &contract_id);

    let mut signers = Vec::new(env);
    signers.push_back(admin.clone());
    for _ in 1..signer_count {
        signers.push_back(Address::generate(env));
    }
    client.init(&admin, &token_address, &1_000_000, &100, &signers, &1, &0);
    client.set_multisig_expiry(&EXPIRY_WINDOW);

    (client, signers, contract_id)
}

/// `set_cooldown` is a valid admin op, so a one-signer proposal can execute.
fn set_cooldown_op(env: &Env, ledgers: u32) -> BatchAdminOp {
    BatchAdminOp {
        op_type: Symbol::new(env, "set_cooldown"),
        payload: Bytes::from_slice(env, &ledgers.to_be_bytes()),
    }
}

fn propose(client: &FiatBridgeClient, env: &Env, signer: &Address) -> u64 {
    client.propose_multisig_action(signer, &set_cooldown_op(env, 42))
}

#[test]
fn proposal_inside_window_survives_cleanup() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, signers, _contract_id) = setup(&env, 1);
    let signer = signers.get(0).unwrap();
    let created_at = env.ledger().sequence();

    let id = propose(&client, &env, &signer);
    env.ledger()
        .set_sequence_number(created_at + EXPIRY_WINDOW - 1);

    let result = client.prune_expired_multisig_proposals(&50);
    assert_eq!(result.pruned, 0);
    assert!(result.is_complete);
    assert!(client.get_multisig_proposal(&id).is_some());
}

#[test]
fn expired_pending_proposal_is_removed_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, signers, contract_id) = setup(&env, 1);
    let signer = signers.get(0).unwrap();
    let created_at = env.ledger().sequence();
    let expires_at = created_at + EXPIRY_WINDOW;

    let id = propose(&client, &env, &signer);
    env.ledger().set_sequence_number(expires_at);

    let result = client.prune_expired_multisig_proposals(&50);
    assert_eq!(result.processed, 1);
    assert_eq!(result.pruned, 1);
    assert!(client.get_multisig_proposal(&id).is_none());

    use soroban_sdk::xdr::{ContractEventBody, ScSymbol, ScVal, StringM};
    let raw = env.events().all().filter_by_contract(&contract_id).events();
    let event = raw.last().expect("cleanup should emit an event");
    let ContractEventBody::V0(body) = &event.body;
    let topic = ScVal::Symbol(ScSymbol(
        StringM::try_from("multisig_expired").expect("valid topic"),
    ));
    assert!(body.topics.contains(&topic));
}

#[test]
fn boundary_is_exclusive_before_expiry_and_inclusive_at_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, signers, _contract_id) = setup(&env, 1);
    let signer = signers.get(0).unwrap();
    let created_at = env.ledger().sequence();

    let first = propose(&client, &env, &signer);
    let second = propose(&client, &env, &signer);

    // One ledger before expiry: both are still live.
    env.ledger()
        .set_sequence_number(created_at + EXPIRY_WINDOW - 1);
    let before = client.prune_expired_multisig_proposals(&50);
    assert_eq!(before.pruned, 0);
    assert!(client.get_multisig_proposal(&first).is_some());
    assert!(client.get_multisig_proposal(&second).is_some());

    // Exactly at expiry: both are expired and prunable.
    env.ledger().set_sequence_number(created_at + EXPIRY_WINDOW);
    let at = client.prune_expired_multisig_proposals(&50);
    assert_eq!(at.pruned, 2);
    assert!(client.get_multisig_proposal(&first).is_none());
    assert!(client.get_multisig_proposal(&second).is_none());
}

#[test]
fn expired_proposal_cannot_execute() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, signers, _contract_id) = setup(&env, 1);
    let signer = signers.get(0).unwrap();
    let created_at = env.ledger().sequence();

    let id = propose(&client, &env, &signer);
    env.ledger().set_sequence_number(created_at + EXPIRY_WINDOW);

    assert_eq!(
        client.try_execute_multisig_action(&id),
        Err(Ok(Error::ProposalExpired))
    );
    // Expiry does not silently delete the record; cleanup owns that transition.
    assert!(client.get_multisig_proposal(&id).is_some());
}

#[test]
fn executed_proposal_is_never_removed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, signers, _contract_id) = setup(&env, 1);
    let signer = signers.get(0).unwrap();
    let created_at = env.ledger().sequence();

    let id = propose(&client, &env, &signer);
    client.execute_multisig_action(&id);
    assert!(client.get_multisig_proposal(&id).unwrap().executed);

    env.ledger()
        .set_sequence_number(created_at + EXPIRY_WINDOW + 1_000);
    let result = client.prune_expired_multisig_proposals(&50);

    assert_eq!(result.pruned, 0);
    let proposal = client.get_multisig_proposal(&id).unwrap();
    assert!(proposal.executed);
}

#[test]
fn unauthorized_caller_cannot_cleanup() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, signers, _contract_id) = setup(&env, 1);
    let signer = signers.get(0).unwrap();
    let created_at = env.ledger().sequence();

    let id = propose(&client, &env, &signer);
    env.ledger().set_sequence_number(created_at + EXPIRY_WINDOW);

    env.set_auths(&[]);
    assert_eq!(
        client.try_prune_expired_multisig_proposals(&50),
        Err(Ok(Error::Unauthorized))
    );

    env.mock_all_auths();
    assert!(client.get_multisig_proposal(&id).is_some());
}

#[test]
fn cleanup_respects_scan_bound_and_drains_over_calls() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, signers, _contract_id) = setup(&env, 1);
    let signer = signers.get(0).unwrap();
    let created_at = env.ledger().sequence();

    let ids = [
        propose(&client, &env, &signer),
        propose(&client, &env, &signer),
        propose(&client, &env, &signer),
    ];
    env.ledger().set_sequence_number(created_at + EXPIRY_WINDOW);

    // Three expired proposals, two scanned per call: the first call must stop
    // at the bound instead of draining everything at once.
    let first = client.prune_expired_multisig_proposals(&2);
    assert_eq!(first.processed, 2);
    assert_eq!(first.pruned, 2);
    assert_eq!(first.next_cursor, 2);
    assert!(!first.is_complete);

    let second = client.prune_expired_multisig_proposals(&2);
    assert_eq!(second.processed, 1);
    assert_eq!(second.pruned, 1);
    assert!(second.is_complete);

    for id in ids {
        assert!(client.get_multisig_proposal(&id).is_none());
    }
}
