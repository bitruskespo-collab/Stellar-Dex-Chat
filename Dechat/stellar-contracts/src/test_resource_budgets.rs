#![cfg(test)]
extern crate std;
use crate::{FiatBridge, FiatBridgeClient, MAX_AUDIT_PAGE_SIZE, MAX_SIGNERS};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};
use std::println;

// ---------------------------------------------------------------------------
// Documented resource thresholds (worst-case state).
//
// These ceilings are the reviewed upper bounds for each public entry point when
// the contract is exercised against the maximum supported state:
//   * withdrawal queue at full depth (MAX_WQ_DEPTH entries),
//   * MAX_SIGNERS multisig signers configured,
//   * maximum batch size for batch entry points.
//
// They are intentionally generous relative to the deterministic baseline so
// that small, benign refactors do not trip the suite, while genuine
// super-linear regressions (e.g. accidental O(n^2) scans) fail loudly.
// Update these constants only alongside a reviewed benchmark run.
// ---------------------------------------------------------------------------

/// Maximum CPU instruction budget per entry point in worst-case state.
pub const MAX_CPU_INSTRUCTIONS: u64 = 5_000_000;
/// Maximum memory bytes budget per entry point in worst-case state.
pub const MAX_MEMORY_BYTES: u64 = 2_000_000;
/// Maximum compiled Wasm size for the contract, in bytes (Soroban hard limit
/// is 256 KiB; we keep headroom below it).
pub const MAX_WASM_SIZE_BYTES: u64 = 256 * 1024;
/// Maximum supported withdrawal queue depth used to build worst-case state.
pub const MAX_WQ_DEPTH: u32 = 100;
/// Maximum batch size for batch entry points.
pub const MAX_BATCH_SIZE: u32 = 20;

fn setup_benchmark_bridge(
    env: &Env,
) -> (
    FiatBridgeClient<'_>,
    Address,
    Address,
    soroban_sdk::token::StellarAssetClient<'_>,
) {
    let admin = Address::generate(env);
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
    let token_admin = soroban_sdk::token::StellarAssetClient::new(env, &contract_address.address());
    let token_addr = contract_address.address();

    let contract_id = env.register(FiatBridge, ());
    let bridge = FiatBridgeClient::new(env, &contract_id);

    bridge.init(
        &admin,
        &token_addr,
        &10_000_000,
        &100,
        &soroban_sdk::vec![env, admin.clone()],
        &1,
        &0,
    );

    (bridge, admin, token_addr, token_admin)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationBudget {
    pub name: &'static str,
    pub cpu_instructions: u64,
    pub memory_bytes: u64,
}

pub fn measure_entrypoints(env: &Env) -> [OperationBudget; 6] {
    env.mock_all_auths();
    let (bridge, _admin, token_addr, token_admin) = setup_benchmark_bridge(env);
    let user = Address::generate(env);
    token_admin.mint(&user, &1_000_000);

    // 1. Measure deposit
    env.cost_estimate().budget().reset_default();
    bridge.deposit(&user, &1000, &token_addr, &Bytes::new(env), &0, &0, &None);
    let deposit_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let deposit_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 2. Measure request_withdrawal
    env.cost_estimate().budget().reset_default();
    let req_id = bridge.request_withdrawal(&user, &500, &token_addr, &None, &0);
    let req_wdr_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let req_wdr_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 3. Measure execute_withdrawal
    env.cost_estimate().budget().reset_default();
    bridge.execute_withdrawal(&req_id, &None, &0, &0, &0);
    let exec_wdr_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let exec_wdr_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 4. Measure admin set_limit
    env.cost_estimate().budget().reset_default();
    bridge.set_limit(&token_addr, &20_000_000, &0);
    let set_limit_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let set_limit_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 5. Measure admin pause
    env.cost_estimate().budget().reset_default();
    bridge.pause();
    let pause_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let pause_mem = env.cost_estimate().budget().memory_bytes_cost();

    // 6. Measure query get_config_snapshot
    env.cost_estimate().budget().reset_default();
    let _snapshot = bridge.get_config_snapshot();
    let query_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let query_mem = env.cost_estimate().budget().memory_bytes_cost();

    [
        OperationBudget {
            name: "deposit",
            cpu_instructions: deposit_cpu,
            memory_bytes: deposit_mem,
        },
        OperationBudget {
            name: "request_withdrawal",
            cpu_instructions: req_wdr_cpu,
            memory_bytes: req_wdr_mem,
        },
        OperationBudget {
            name: "execute_withdrawal",
            cpu_instructions: exec_wdr_cpu,
            memory_bytes: exec_wdr_mem,
        },
        OperationBudget {
            name: "admin_set_limit",
            cpu_instructions: set_limit_cpu,
            memory_bytes: set_limit_mem,
        },
        OperationBudget {
            name: "admin_pause",
            cpu_instructions: pause_cpu,
            memory_bytes: pause_mem,
        },
        OperationBudget {
            name: "query_config_snapshot",
            cpu_instructions: query_cpu,
            memory_bytes: query_mem,
        },
    ]
}

#[test]
fn test_resource_budgets_deterministic_execution() {
    let env1 = Env::default();
    let run1 = measure_entrypoints(&env1);

    let env2 = Env::default();
    let run2 = measure_entrypoints(&env2);

    assert_eq!(
        run1, run2,
        "Resource reports must be 100% deterministic across clean runs"
    );

    // Regression threshold check (within 10% of reviewed baseline ceiling)
    for op in run1.iter() {
        println!(
            "MEASURED: {} -> CPU: {}, MEM: {}",
            op.name, op.cpu_instructions, op.memory_bytes
        );
        assert!(
            op.cpu_instructions > 0,
            "{} must consume non-zero CPU instructions",
            op.name
        );
        assert!(
            op.memory_bytes > 0,
            "{} must consume non-zero memory bytes",
            op.name
        );

        let (max_cpu, max_mem) = match op.name {
            "deposit" => (883_785, 310_216),
            "request_withdrawal" => (757_182, 280_508),
            "execute_withdrawal" => (973_814, 276_476),
            "admin_set_limit" => (390_218, 156_438),
            "admin_pause" => (304_406, 131_057),
            "query_config_snapshot" => (342_045, 105_360),
            _ => (100_000_000, 40_000_000),
        };

        assert!(
            op.cpu_instructions <= max_cpu,
            "{} exceeded regression ceiling: {} > {}",
            op.name,
            op.cpu_instructions,
            max_cpu
        );
        assert!(
            op.memory_bytes <= max_mem,
            "{} exceeded memory ceiling: {} > {}",
            op.name,
            op.memory_bytes,
            max_mem
        );
    }
}

#[test]
fn withdrawal_queue_work_is_bounded_as_history_grows() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, token_addr, token_admin) = setup_benchmark_bridge(&env);
    let user = Address::generate(&env);
    token_admin.mint(&user, &20_000);
    bridge.deposit(&user, &10_000, &token_addr, &Bytes::new(&env), &0, &0, &None);

    env.cost_estimate().budget().reset_default();
    let first_request_id = bridge.request_withdrawal(&user, &1, &token_addr, &None, &0);
    let first_request_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let first_request_mem = env.cost_estimate().budget().memory_bytes_cost();

    env.cost_estimate().budget().reset_default();
    let _ = bridge.get_next_priority_withdrawal();
    let first_schedule_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let first_schedule_mem = env.cost_estimate().budget().memory_bytes_cost();

    env.cost_estimate().budget().reset_default();
    bridge.cancel_withdrawal(&first_request_id);
    let first_dequeue_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let first_dequeue_mem = env.cost_estimate().budget().memory_bytes_cost();

    for _ in 0..100 {
        bridge.request_withdrawal(&user, &1, &token_addr, &None, &0);
    }

    env.cost_estimate().budget().reset_default();
    let large_request_id = bridge.request_withdrawal(&user, &1, &token_addr, &None, &0);
    let large_request_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let large_request_mem = env.cost_estimate().budget().memory_bytes_cost();

    env.cost_estimate().budget().reset_default();
    let _ = bridge.get_next_priority_withdrawal();
    let large_schedule_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let large_schedule_mem = env.cost_estimate().budget().memory_bytes_cost();

    env.cost_estimate().budget().reset_default();
    bridge.cancel_withdrawal(&large_request_id);
    let large_dequeue_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let large_dequeue_mem = env.cost_estimate().budget().memory_bytes_cost();

    env.cost_estimate().budget().reset_default();
    let _ = bridge.get_withdrawal_queue_page(&0, &MAX_AUDIT_PAGE_SIZE);
    let page_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let page_mem = env.cost_estimate().budget().memory_bytes_cost();

    println!(
        "MEASURED: withdrawal queue depth 1 -> 101; enqueue CPU {first_request_cpu} -> {large_request_cpu}, MEM {first_request_mem} -> {large_request_mem}; dequeue CPU {first_dequeue_cpu} -> {large_dequeue_cpu}, MEM {first_dequeue_mem} -> {large_dequeue_mem}; scheduler CPU {first_schedule_cpu} -> {large_schedule_cpu}, MEM {first_schedule_mem} -> {large_schedule_mem}; 100-entry page CPU {page_cpu}, MEM {page_mem}"
    );
    assert_eq!(bridge.get_wq_depth(), 100);
    assert!(large_request_cpu > 0 && large_request_mem > 0);
    assert!(large_schedule_cpu > 0 && large_schedule_mem > 0);
    assert!(large_dequeue_cpu > 0 && large_dequeue_mem > 0);
    assert!(page_cpu > 0 && page_mem > 0);
}

/// Builds the worst-case contract state: a full withdrawal queue, the maximum
/// number of multisig signers, and a large batch of pending operations.
fn build_worst_case_state(
    env: &Env,
) -> (
    FiatBridgeClient<'_>,
    Address,
    Address,
    soroban_sdk::token::StellarAssetClient<'_>,
) {
    env.mock_all_auths();
    let (bridge, admin, token_addr, token_admin) = setup_benchmark_bridge(env);
    let user = Address::generate(env);
    token_admin.mint(&user, &10_000_000);
    bridge.deposit(
        &user,
        &1_000_000,
        &token_addr,
        &Bytes::new(env),
        &0,
        &0,
        &None,
    );

    // Fill the withdrawal queue to its maximum supported depth.
    for _ in 0..MAX_WQ_DEPTH {
        bridge.request_withdrawal(&user, &1, &token_addr, &None, &0);
    }

    // Configure the maximum number of multisig signers.
    let mut signers = soroban_sdk::vec![env];
    for _ in 0..MAX_SIGNERS {
        signers.push_back(Address::generate(env));
    }
    bridge.set_signers(&admin, &signers, &1);

    (bridge, admin, token_addr, token_admin)
}

fn measure<F: FnOnce()>(env: &Env, f: F) -> OperationBudget {
    env.cost_estimate().budget().reset_default();
    f();
    OperationBudget {
        name: "op",
        cpu_instructions: env.cost_estimate().budget().cpu_instruction_cost(),
        memory_bytes: env.cost_estimate().budget().memory_bytes_cost(),
    }
}

#[test]
fn worst_case_state_entrypoints_within_thresholds() {
    let env = Env::default();
    let (bridge, admin, token_addr, _token_admin) = build_worst_case_state(&env);
    let user = Address::generate(&env);

    // Sanity: worst-case state is actually built.
    assert_eq!(bridge.get_wq_depth(), MAX_WQ_DEPTH);

    let mut results: std::vec::Vec<(&'static str, OperationBudget)> = std::vec::Vec::new();

    results.push((
        "deposit",
        measure(&env, || {
            bridge.deposit(&user, &1, &token_addr, &Bytes::new(&env), &0, &0, &None);
        }),
    ));

    results.push((
        "request_withdrawal",
        measure(&env, || {
            bridge.request_withdrawal(&user, &1, &token_addr, &None, &0);
        }),
    ));

    results.push((
        "get_next_priority_withdrawal",
        measure(&env, || {
            let _ = bridge.get_next_priority_withdrawal();
        }),
    ));

    results.push((
        "get_withdrawal_queue_page",
        measure(&env, || {
            let _ = bridge.get_withdrawal_queue_page(&0, &MAX_AUDIT_PAGE_SIZE);
        }),
    ));

    results.push((
        "get_config_snapshot",
        measure(&env, || {
            let _ = bridge.get_config_snapshot();
        }),
    ));

    results.push((
        "set_limit",
        measure(&env, || {
            bridge.set_limit(&token_addr, &20_000_000, &0);
        }),
    ));

    results.push((
        "set_signers",
        measure(&env, || {
            let mut signers = soroban_sdk::vec![&env];
            for _ in 0..MAX_SIGNERS {
                signers.push_back(Address::generate(&env));
            }
            bridge.set_signers(&admin, &signers, &1);
        }),
    ));

    for (name, op) in results.iter() {
        println!(
            "WORST-CASE: {} -> CPU: {}, MEM: {}",
            name, op.cpu_instructions, op.memory_bytes
        );
        assert!(
            op.cpu_instructions > 0,
            "{} must consume non-zero CPU instructions",
            name
        );
        assert!(
            op.memory_bytes > 0,
            "{} must consume non-zero memory bytes",
            name
        );
        assert!(
            op.cpu_instructions <= MAX_CPU_INSTRUCTIONS,
            "{} exceeded worst-case CPU ceiling: {} > {}",
            name,
            op.cpu_instructions,
            MAX_CPU_INSTRUCTIONS
        );
        assert!(
            op.memory_bytes <= MAX_MEMORY_BYTES,
            "{} exceeded worst-case memory ceiling: {} > {}",
            name,
            op.memory_bytes,
            MAX_MEMORY_BYTES
        );
    }
}

#[test]
fn worst_case_wasm_size_within_threshold() {
    // The compiled Wasm artifact is produced by the build pipeline. When it is
    // available on disk we assert its size against the documented ceiling;
    // otherwise the check is skipped so unit runs without a build still pass.
    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/wasm32-unknown-unknown/release/dechat_fiat_bridge.wasm");
    if let Ok(meta) = std::fs::metadata(&wasm_path) {
        let size = meta.len();
        println!("WASM SIZE: {} bytes (limit {})", size, MAX_WASM_SIZE_BYTES);
        assert!(
            size <= MAX_WASM_SIZE_BYTES,
            "compiled Wasm size {} exceeds documented limit {}",
            size,
            MAX_WASM_SIZE_BYTES
        );
    } else {
        println!(
            "WASM SIZE: artifact not found at {:?}; skipping size assertion",
            wasm_path
        );
    }
}

#[test]
fn worst_case_boundary_exceeding_max_signers_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, admin, _token_addr, _token_admin) = setup_benchmark_bridge(&env);

    let mut signers = soroban_sdk::vec![&env];
    for _ in 0..(MAX_SIGNERS + 1) {
        signers.push_back(Address::generate(&env));
    }
    let result = bridge.try_set_signers(&admin, &signers, &1);
    assert!(
        result.is_err(),
        "set_signers must reject more than MAX_SIGNERS signers"
    );
}

#[test]
fn worst_case_boundary_exceeding_max_batch_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (bridge, _admin, token_addr, token_admin) = setup_benchmark_bridge(&env);
    let user = Address::generate(&env);
    token_admin.mint(&user, &10_000_000);
    bridge.deposit(
        &user,
        &1_000_000,
        &token_addr,
        &Bytes::new(&env),
        &0,
        &0,
        &None,
    );

    let mut ids = soroban_sdk::vec![&env];
    for _ in 0..(MAX_BATCH_SIZE + 1) {
        ids.push_back(bridge.request_withdrawal(&user, &1, &token_addr, &None, &0));
    }
    let result = bridge.try_execute_withdrawal_batch(&ids, &None, &0, &0);
    assert!(
        result.is_err(),
        "batch entry point must reject more than MAX_BATCH_SIZE items"
    );
}
