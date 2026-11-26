//! Regression tests for Issue #174: Bind multisig approvals to an immutable
//! proposal policy snapshot.
//!
//! These tests verify that:
//! - Every `MultisigProposal` and `SignerRotationProposal` records the active
//!   policy version, signer set, and threshold at proposal creation time.
//! - Signer-set or threshold changes via `execute_signer_rotation` advance the
//!   monotonic policy version and prevent prior approvals on pending proposals
//!   from being reinterpreted under a new signer set or threshold.
//! - Rotating away and back to an identical signer set and threshold still
//!   rejects stale proposals via the policy version binding.
//! - Rejected approval/execution calls leave proposal and contract state
//!   untouched, while fresh proposals created under the new policy succeed.

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Bytes, Env, Symbol, Vec,
};
use stellar_contracts::{
    BatchAdminOp, DataKey, Error, FiatBridge, FiatBridgeClient, MultisigPolicySnapshot,
    INITIAL_MULTISIG_POLICY_VERSION,
};

fn setup_bridge(
    env: &Env,
    signer_count: u32,
    threshold: u32,
) -> (FiatBridgeClient<'_>, Address, Vec<Address>) {
    let contract_id = env.register(FiatBridge, ());
    let client = FiatBridgeClient::new(env, &contract_id);

    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_addr = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let mut signers = Vec::new(env);
    signers.push_back(admin.clone());
    for _ in 1..signer_count {
        signers.push_back(Address::generate(env));
    }

    client.init(
        &admin,
        &token_addr,
        &10_000_000i128,
        &1i128,
        &signers,
        &threshold,
        &0,
    );

    (client, admin, signers)
}

fn set_cooldown_op(env: &Env, ledgers: u32) -> BatchAdminOp {
    BatchAdminOp {
        op_type: Symbol::new(env, "set_cooldown"),
        payload: Bytes::from_slice(env, &ledgers.to_be_bytes()),
    }
}

fn rotate_policy(
    env: &Env,
    client: &FiatBridgeClient<'_>,
    approvers: &[Address],
    new_signers: &Vec<Address>,
    new_threshold: u32,
) -> u64 {
    let delay = 10u32;
    let rot_id = client.propose_signer_rotation(&approvers[0], new_signers, &new_threshold, &delay);
    for approver in &approvers[1..] {
        client.approve_signer_rotation(approver, &rot_id);
    }
    let next_ledger = env.ledger().sequence() + delay;
    env.ledger().with_mut(|l| l.sequence_number = next_ledger);
    client.execute_signer_rotation(&rot_id);
    rot_id
}

#[test]
fn policy_version_and_snapshot_are_initialized_and_recorded_on_proposals() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let uninit_id = env.register(FiatBridge, ());
    let uninit = FiatBridgeClient::new(&env, &uninit_id);
    assert_eq!(uninit.get_multisig_policy_version(), 0);
    assert_eq!(uninit.get_multisig_policy_snapshot(), None);

    let (client, _admin, signers) = setup_bridge(&env, 3, 2);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();

    assert_eq!(
        client.get_multisig_policy_version(),
        INITIAL_MULTISIG_POLICY_VERSION
    );
    assert_eq!(
        client.get_multisig_policy_snapshot(),
        Some(MultisigPolicySnapshot {
            version: INITIAL_MULTISIG_POLICY_VERSION,
            signers: signers.clone(),
            threshold: 2,
        })
    );

    let action_id = client.propose_multisig_action(&s1, &set_cooldown_op(&env, 42));
    let ms_prop = client.get_multisig_proposal(&action_id).unwrap();
    assert_eq!(ms_prop.policy_version, 1);
    assert_eq!(ms_prop.policy_signers, signers);
    assert_eq!(ms_prop.policy_threshold, 2);

    client.approve_multisig_action(&s2, &action_id);
    client.execute_multisig_action(&action_id);
    assert_eq!(client.get_cooldown(), 42);

    // Snapshot on executed proposal remains unchanged.
    let ms_prop_after = client.get_multisig_proposal(&action_id).unwrap();
    assert!(ms_prop_after.executed);
    assert_eq!(ms_prop_after.policy_version, 1);
    assert_eq!(ms_prop_after.policy_signers, signers);
    assert_eq!(ms_prop_after.policy_threshold, 2);

    // Signer rotation proposals also bind the active policy snapshot.
    let next_signers = vec![&env, s1.clone(), s2.clone()];
    let rot_id = client.propose_signer_rotation(&s1, &next_signers, &2, &15);
    let rot_prop = client.get_signer_rotation_proposal(&rot_id).unwrap();
    assert_eq!(rot_prop.policy_version, 1);
    assert_eq!(rot_prop.policy_signers, signers);
    assert_eq!(rot_prop.policy_threshold, 2);
}

#[test]
fn lowering_threshold_cannot_reinterpret_pending_subthreshold_approvals() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    // Start at 3-of-3.
    let (client, _admin, signers) = setup_bridge(&env, 3, 3);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();
    let s3 = signers.get(2).unwrap();

    // Pending proposal gets 2 approvals (below v1 threshold of 3).
    let pending_id = client.propose_multisig_action(&s1, &set_cooldown_op(&env, 777));
    client.approve_multisig_action(&s2, &pending_id);
    let cooldown_before = client.get_cooldown();
    let pending_before = client.get_multisig_proposal(&pending_id).unwrap();
    assert_eq!(pending_before.approvals.len(), 2);
    assert_eq!(pending_before.policy_version, 1);
    assert_eq!(pending_before.policy_threshold, 3);

    // Rotate policy to lower threshold to 2-of-3 with the exact same signers.
    rotate_policy(
        &env,
        &client,
        &[s1.clone(), s2.clone(), s3.clone()],
        &signers,
        2,
    );
    assert_eq!(client.get_multisig_policy_version(), 2);
    assert_eq!(client.get_multisig_threshold(), 2);

    // Previously collected 2 approvals MUST NOT be reinterpreted as satisfying
    // the new threshold of 2.
    let exec_err = client.try_execute_multisig_action(&pending_id);
    assert_eq!(exec_err, Err(Ok(Error::PolicyVersionMismatch)));
    assert_eq!(client.get_cooldown(), cooldown_before);

    // Further approvals on the stale v1 proposal are also rejected cleanly.
    let approve_err = client.try_approve_multisig_action(&s3, &pending_id);
    assert_eq!(approve_err, Err(Ok(Error::PolicyVersionMismatch)));

    // Proposal record and its immutable v1 snapshot were not mutated.
    let pending_after = client.get_multisig_proposal(&pending_id).unwrap();
    assert_eq!(pending_after, pending_before);

    // Re-proposing under policy v2 captures snapshot v2 and executes with 2-of-3.
    let fresh_id = client.propose_multisig_action(&s1, &set_cooldown_op(&env, 777));
    let fresh_prop = client.get_multisig_proposal(&fresh_id).unwrap();
    assert_eq!(fresh_prop.policy_version, 2);
    assert_eq!(fresh_prop.policy_threshold, 2);
    client.approve_multisig_action(&s2, &fresh_id);
    client.execute_multisig_action(&fresh_id);
    assert_eq!(client.get_cooldown(), 777);
}

#[test]
fn raising_threshold_invalidates_pending_unexecuted_proposal_even_if_old_quorum_was_met() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    // Start at 2-of-3.
    let (client, _admin, signers) = setup_bridge(&env, 3, 2);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();
    let s3 = signers.get(2).unwrap();

    // Pending proposal collects 2 approvals (met v1 quorum, not yet executed).
    let pending_id = client.propose_multisig_action(&s1, &set_cooldown_op(&env, 888));
    client.approve_multisig_action(&s2, &pending_id);

    // Rotate to 3-of-3 before execution.
    rotate_policy(&env, &client, &[s1.clone(), s2.clone()], &signers, 3);
    assert_eq!(client.get_multisig_policy_version(), 2);

    // Executing or topping up the v1 proposal fails with PolicyVersionMismatch.
    assert_eq!(
        client.try_execute_multisig_action(&pending_id),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert_eq!(
        client.try_approve_multisig_action(&s3, &pending_id),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert!(!client.get_multisig_proposal(&pending_id).unwrap().executed);
    assert_eq!(client.get_cooldown(), 0);
}

#[test]
fn signer_set_rotation_blocks_removed_and_new_signers_from_using_pending_proposals() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, signers) = setup_bridge(&env, 3, 2);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();
    let s3 = signers.get(2).unwrap();
    let s4 = Address::generate(&env);

    // s1 creates a pending proposal under v1 ([s1, s2, s3], threshold 2).
    let pending_id = client.propose_multisig_action(&s1, &set_cooldown_op(&env, 321));

    // Rotate signer set to [s2, s3, s4] (removing s1, adding s4), threshold 2.
    let v2_signers = vec![&env, s2.clone(), s3.clone(), s4.clone()];
    rotate_policy(&env, &client, &[s1.clone(), s2.clone()], &v2_signers, 2);
    assert_eq!(client.get_multisig_policy_version(), 2);

    // Removed signer s1 is rejected with Unauthorized on approve and propose.
    assert_eq!(
        client.try_approve_multisig_action(&s1, &pending_id),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_propose_multisig_action(&s1, &set_cooldown_op(&env, 1)),
        Err(Ok(Error::Unauthorized))
    );

    // New signer s4 and continuing signer s2 cannot approve or execute the v1 proposal.
    assert_eq!(
        client.try_approve_multisig_action(&s4, &pending_id),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert_eq!(
        client.try_approve_multisig_action(&s2, &pending_id),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert_eq!(
        client.try_execute_multisig_action(&pending_id),
        Err(Ok(Error::PolicyVersionMismatch))
    );

    // Fresh proposal under v2 binds to [s2, s3, s4] and succeeds.
    let v2_id = client.propose_multisig_action(&s4, &set_cooldown_op(&env, 321));
    let v2_prop = client.get_multisig_proposal(&v2_id).unwrap();
    assert_eq!(v2_prop.policy_version, 2);
    assert_eq!(v2_prop.policy_signers, v2_signers);
    assert_eq!(v2_prop.policy_threshold, 2);

    client.approve_multisig_action(&s2, &v2_id);
    client.execute_multisig_action(&v2_id);
    assert_eq!(client.get_cooldown(), 321);
}

#[test]
fn rotating_away_and_back_to_identical_policy_still_rejects_v1_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, signers) = setup_bridge(&env, 3, 2);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();
    let s3 = signers.get(2).unwrap();

    // Pending proposal created and fully approved under v1 ([s1, s2, s3], 2).
    let pending_id = client.propose_multisig_action(&s1, &set_cooldown_op(&env, 555));
    client.approve_multisig_action(&s2, &pending_id);

    // Rotate v1 -> v2 (3-of-3), then v2 -> v3 (back to 2-of-3 with identical signers).
    rotate_policy(&env, &client, &[s1.clone(), s2.clone()], &signers, 3);
    rotate_policy(
        &env,
        &client,
        &[s1.clone(), s2.clone(), s3.clone()],
        &signers,
        2,
    );

    assert_eq!(client.get_multisig_policy_version(), 3);
    assert_eq!(client.get_multisig_signers(), signers);
    assert_eq!(client.get_multisig_threshold(), 2);

    // Even though signers and threshold match v1 again, version 1 != 3 blocks execution.
    assert_eq!(
        client.try_execute_multisig_action(&pending_id),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert_eq!(
        client.try_approve_multisig_action(&s3, &pending_id),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert_eq!(client.get_cooldown(), 0);
}

#[test]
fn executing_one_rotation_invalidates_competing_pending_rotation_proposals() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, signers) = setup_bridge(&env, 3, 2);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();
    let s3 = signers.get(2).unwrap();

    let set_a = vec![&env, s1.clone(), s2.clone()];
    let attacker = Address::generate(&env);
    let set_b = vec![&env, attacker.clone()];

    // Both rotations are proposed and approved under policy v1.
    let rot_a = client.propose_signer_rotation(&s1, &set_a, &2, &10);
    let rot_b = client.propose_signer_rotation(&s1, &set_b, &1, &10);
    client.approve_signer_rotation(&s2, &rot_a);
    client.approve_signer_rotation(&s2, &rot_b);

    env.ledger().with_mut(|l| l.sequence_number = 115);

    // Executing rot_a advances policy to v2.
    client.execute_signer_rotation(&rot_a);
    assert_eq!(client.get_multisig_policy_version(), 2);
    assert_eq!(client.get_multisig_signers(), set_a);

    // Competing pending rotation rot_b from v1 can no longer be approved or executed.
    assert_eq!(
        client.try_approve_signer_rotation(&s2, &rot_b),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert_eq!(
        client.try_execute_signer_rotation(&rot_b),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert_eq!(
        client.try_approve_signer_rotation(&s3, &rot_b),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.get_multisig_signers(), set_a);
    assert_eq!(client.get_multisig_policy_version(), 2);

    // Stale rotation proposals can still be cancelled cleanly for housekeeping.
    client.cancel_signer_rotation(&s1, &rot_b);
    assert!(
        client
            .get_signer_rotation_proposal(&rot_b)
            .unwrap()
            .cancelled
    );
}

#[test]
fn legacy_or_zero_version_proposal_snapshot_fails_closed() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.sequence_number = 100);

    let (client, _admin, signers) = setup_bridge(&env, 3, 2);
    let s1 = signers.get(0).unwrap();
    let s2 = signers.get(1).unwrap();

    let id = client.propose_multisig_action(&s1, &set_cooldown_op(&env, 99));
    client.approve_multisig_action(&s2, &id);

    // Simulate a legacy or zero-version snapshot stored prior to policy binding.
    env.as_contract(&client.address, || {
        let mut prop: stellar_contracts::MultisigProposal = env
            .storage()
            .instance()
            .get(&DataKey::MultisigProposal(id))
            .unwrap();
        prop.policy_version = 0;
        env.storage()
            .instance()
            .set(&DataKey::MultisigProposal(id), &prop);
    });

    assert_eq!(
        client.try_execute_multisig_action(&id),
        Err(Ok(Error::PolicyVersionMismatch))
    );
    assert_eq!(client.get_cooldown(), 0);
}
