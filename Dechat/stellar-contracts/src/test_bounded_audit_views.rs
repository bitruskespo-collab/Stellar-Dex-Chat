#![cfg(test)]

use crate::{
    Error, FiatBridge, FiatBridgeClient, LiabilityAuditStatus, ReceiptAuditStatus,
    AUDIT_SCHEMA_VERSION, MAX_AUDIT_PAGE_SIZE,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, Address, Bytes, Env,
};

fn setup_bridge<'a>(
    env: &Env,
) -> (
    Address,
    FiatBridgeClient<'a>,
    Address,
    Address,
    StellarAssetClient<'a>,
) {
    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_sac = StellarAssetClient::new(env, &token_addr);
    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);
    let signers = vec![env, admin.clone()];
    bridge.init(&admin, &token_addr, &1_000_000_000, &1, &signers, &1, &0);
    bridge.set_limit(&token_addr, &1_000_000_000i128, &0);
    (contract_id, bridge, admin, token_addr, token_sac)
}

#[test]
fn test_empty_audit_views() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, bridge, _, _, _) = setup_bridge(&env);

    let receipt_page = bridge.get_receipt_audit_views(&0, &10);
    assert_eq!(receipt_page.records.len(), 0);
    assert!(receipt_page.next_cursor.is_none());

    let liability_page = bridge.get_liability_audit_views(&0, &10);
    assert_eq!(liability_page.records.len(), 0);
    assert!(liability_page.next_cursor.is_none());

    // Out of bounds cursor on empty contract
    let oob_receipt = bridge.get_receipt_audit_views(&50, &10);
    assert_eq!(oob_receipt.records.len(), 0);
    assert!(oob_receipt.next_cursor.is_none());

    let oob_liability = bridge.get_liability_audit_views(&50, &10);
    assert_eq!(oob_liability.records.len(), 0);
    assert!(oob_liability.next_cursor.is_none());
}

#[test]
fn test_page_size_validation() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, bridge, _, _, _) = setup_bridge(&env);

    // limit == 0 rejected
    assert_eq!(
        bridge.try_get_receipt_audit_views(&0, &0),
        Err(Ok(Error::InvalidPageSize))
    );
    assert_eq!(
        bridge.try_get_liability_audit_views(&0, &0),
        Err(Ok(Error::InvalidPageSize))
    );

    // limit > MAX_AUDIT_PAGE_SIZE rejected
    assert_eq!(
        bridge.try_get_receipt_audit_views(&0, &(MAX_AUDIT_PAGE_SIZE + 1)),
        Err(Ok(Error::InvalidPageSize))
    );
    assert_eq!(
        bridge.try_get_liability_audit_views(&0, &(MAX_AUDIT_PAGE_SIZE + 1)),
        Err(Ok(Error::InvalidPageSize))
    );

    // limit == MAX_AUDIT_PAGE_SIZE accepted
    let max_receipts = bridge.get_receipt_audit_views(&0, &MAX_AUDIT_PAGE_SIZE);
    assert_eq!(max_receipts.records.len(), 0);

    let max_liabilities = bridge.get_liability_audit_views(&0, &MAX_AUDIT_PAGE_SIZE);
    assert_eq!(max_liabilities.records.len(), 0);
}

#[test]
fn test_receipt_deterministic_pagination_across_insertions() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, bridge, _, token_addr, token_sac) = setup_bridge(&env);

    let user = Address::generate(&env);
    token_sac.mint(&user, &100_000);

    // Insert 5 receipts
    for i in 1..=5 {
        let amount = (i * 100) as i128;
        let mut ref_bytes = Bytes::new(&env);
        ref_bytes.push_back(i as u8);
        bridge.deposit(&user, &amount, &token_addr, &ref_bytes, &0, &0, &None);
    }

    // Page 1: cursor 0, limit 2
    let page1 = bridge.get_receipt_audit_views(&0, &2);
    assert_eq!(page1.records.len(), 2);
    assert_eq!(page1.next_cursor, Some(2));
    assert_eq!(page1.records.get(0).unwrap().amount, 100);
    assert_eq!(page1.records.get(0).unwrap().token, token_addr);
    assert_eq!(page1.records.get(0).unwrap().version, AUDIT_SCHEMA_VERSION);
    assert_eq!(
        page1.records.get(0).unwrap().status,
        ReceiptAuditStatus::Active
    );
    assert_eq!(page1.records.get(1).unwrap().amount, 200);

    // Page 2: cursor 2, limit 2
    let page2 = bridge.get_receipt_audit_views(&2, &2);
    assert_eq!(page2.records.len(), 2);
    assert_eq!(page2.next_cursor, Some(4));
    assert_eq!(page2.records.get(0).unwrap().amount, 300);
    assert_eq!(page2.records.get(1).unwrap().amount, 400);

    // Page 3: cursor 4, limit 2
    let page3 = bridge.get_receipt_audit_views(&4, &2);
    assert_eq!(page3.records.len(), 1);
    assert_eq!(page3.next_cursor, None);
    assert_eq!(page3.records.get(0).unwrap().amount, 500);

    // Add 2 more receipts (total 7)
    for i in 6..=7 {
        let amount = (i * 100) as i128;
        bridge.deposit(&user, &amount, &token_addr, &Bytes::new(&env), &0, &0, &None);
    }

    // Re-verify Page 1 and Page 2 are deterministic and unchanged
    let page1_after = bridge.get_receipt_audit_views(&0, &2);
    assert_eq!(page1_after.records.len(), 2);
    assert_eq!(page1_after.records.get(0).unwrap().amount, 100);
    assert_eq!(page1_after.records.get(1).unwrap().amount, 200);
    assert_eq!(page1_after.next_cursor, Some(2));

    // Page 3 now has next_cursor = Some(6)
    let page3_after = bridge.get_receipt_audit_views(&4, &2);
    assert_eq!(page3_after.records.len(), 2);
    assert_eq!(page3_after.records.get(0).unwrap().amount, 500);
    assert_eq!(page3_after.records.get(1).unwrap().amount, 600);
    assert_eq!(page3_after.next_cursor, Some(6));

    // Page 4: cursor 6, limit 2
    let page4 = bridge.get_receipt_audit_views(&6, &2);
    assert_eq!(page4.records.len(), 1);
    assert_eq!(page4.records.get(0).unwrap().amount, 700);
    assert_eq!(page4.next_cursor, None);
}

#[test]
fn test_receipt_pagination_across_terminal_state_changes() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, bridge, _, token_addr, token_sac) = setup_bridge(&env);

    let user = Address::generate(&env);
    token_sac.mint(&user, &10_000);

    // Insert 3 receipts
    bridge.deposit(&user, &100, &token_addr, &Bytes::new(&env), &0, &0, &None);
    bridge.deposit(&user, &200, &token_addr, &Bytes::new(&env), &0, &0, &None);
    bridge.deposit(&user, &300, &token_addr, &Bytes::new(&env), &0, &0, &None);

    // Initial state: all Active
    let page_before = bridge.get_receipt_audit_views(&0, &3);
    assert_eq!(page_before.records.len(), 3);
    assert_eq!(
        page_before.records.get(0).unwrap().status,
        ReceiptAuditStatus::Active
    );
    assert_eq!(
        page_before.records.get(1).unwrap().status,
        ReceiptAuditStatus::Active
    );
    assert_eq!(
        page_before.records.get(2).unwrap().status,
        ReceiptAuditStatus::Active
    );

    // Migrate 1 receipt (batch size 1)
    let migrated = bridge.migrate_escrow(&1);
    assert_eq!(migrated, 1);

    // Stable cursor verification: item 0 is Migrated, items 1 and 2 remain Active
    let page_after_1 = bridge.get_receipt_audit_views(&0, &3);
    assert_eq!(page_after_1.records.len(), 3);
    assert_eq!(
        page_after_1.records.get(0).unwrap().status,
        ReceiptAuditStatus::Migrated
    );
    assert_eq!(page_after_1.records.get(0).unwrap().amount, 100);
    assert_eq!(
        page_after_1.records.get(1).unwrap().status,
        ReceiptAuditStatus::Active
    );
    assert_eq!(page_after_1.records.get(1).unwrap().amount, 200);
    assert_eq!(
        page_after_1.records.get(2).unwrap().status,
        ReceiptAuditStatus::Active
    );

    // Migrate remaining receipts
    let migrated_rest = bridge.migrate_escrow(&2);
    assert_eq!(migrated_rest, 2);

    let page_after_all = bridge.get_receipt_audit_views(&0, &3);
    assert_eq!(page_after_all.records.len(), 3);
    assert_eq!(
        page_after_all.records.get(0).unwrap().status,
        ReceiptAuditStatus::Migrated
    );
    assert_eq!(
        page_after_all.records.get(1).unwrap().status,
        ReceiptAuditStatus::Migrated
    );
    assert_eq!(
        page_after_all.records.get(2).unwrap().status,
        ReceiptAuditStatus::Migrated
    );
}

#[test]
fn test_liability_deterministic_pagination_across_terminal_states() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, bridge, admin, token_addr, token_sac) = setup_bridge(&env);

    // Fund admin and deposit to back liabilities
    token_sac.mint(&admin, &100_000);
    bridge.deposit(&admin, &100_000, &token_addr, &Bytes::new(&env), &0, &0, &None);

    // Request 4 withdrawals: IDs 0, 1, 2, 3
    let id0 = bridge.request_withdrawal(&admin, &1_000, &token_addr, &None, &0);
    let id1 = bridge.request_withdrawal(&admin, &2_000, &token_addr, &None, &0);
    let id2 = bridge.request_withdrawal(&admin, &3_000, &token_addr, &None, &0);
    let id3 = bridge.request_withdrawal(&admin, &4_000, &token_addr, &None, &0);

    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(id3, 3);

    // Initial page check: all Queued
    let page1 = bridge.get_liability_audit_views(&0, &2);
    assert_eq!(page1.records.len(), 2);
    assert_eq!(page1.next_cursor, Some(2));
    assert_eq!(page1.records.get(0).unwrap().request_id, 0);
    assert_eq!(page1.records.get(0).unwrap().amount, 1_000);
    assert_eq!(page1.records.get(0).unwrap().token, token_addr);
    assert_eq!(
        page1.records.get(0).unwrap().status,
        LiabilityAuditStatus::Queued
    );
    assert_eq!(page1.records.get(0).unwrap().version, AUDIT_SCHEMA_VERSION);

    // Terminal state change 1: Execute withdrawal 0
    bridge.execute_withdrawal(&id0, &None, &0i128, &0u32, &0u64);

    // Terminal state change 2: Cancel withdrawal 1
    bridge.cancel_withdrawal(&id1);

    // Terminal state change 3: Expire withdrawal 2
    // Fast-forward past default expiry window (518_400 ledgers)
    env.ledger().set_sequence_number(600_000);
    bridge.reclaim_expired_withdrawal(&id2);

    // Verify pagination across terminal states
    let page1_after = bridge.get_liability_audit_views(&0, &2);
    assert_eq!(page1_after.records.len(), 2);
    assert_eq!(page1_after.next_cursor, Some(2));
    assert_eq!(page1_after.records.get(0).unwrap().request_id, 0);
    assert_eq!(
        page1_after.records.get(0).unwrap().status,
        LiabilityAuditStatus::Executed
    );
    assert_eq!(page1_after.records.get(1).unwrap().request_id, 1);
    assert_eq!(
        page1_after.records.get(1).unwrap().status,
        LiabilityAuditStatus::Cancelled
    );

    let page2_after = bridge.get_liability_audit_views(&2, &2);
    assert_eq!(page2_after.records.len(), 2);
    assert_eq!(page2_after.next_cursor, None);
    assert_eq!(page2_after.records.get(0).unwrap().request_id, 2);
    assert_eq!(
        page2_after.records.get(0).unwrap().status,
        LiabilityAuditStatus::Expired
    );
    assert_eq!(page2_after.records.get(1).unwrap().request_id, 3);
    assert_eq!(
        page2_after.records.get(1).unwrap().status,
        LiabilityAuditStatus::Queued
    );
}

#[test]
fn test_alias_views_match() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, bridge, _, _, _) = setup_bridge(&env);

    let p1 = bridge.get_receipt_audit_views(&0, &10);
    let p2 = bridge.get_receipts_page(&0, &10);
    assert_eq!(p1.records, p2.records);
    assert_eq!(p1.next_cursor, p2.next_cursor);

    let l1 = bridge.get_liability_audit_views(&0, &10);
    let l2 = bridge.get_liabilities_page(&0, &10);
    assert_eq!(l1.records, l2.records);
    assert_eq!(l1.next_cursor, l2.next_cursor);
}
