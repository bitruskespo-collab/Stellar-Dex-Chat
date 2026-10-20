'use client';

import React from 'react';
import { SystemHealthStatus } from '../lib/degradedModeManager';

interface DegradedModeBannerProps {
  health: SystemHealthStatus;
}

export const DegradedModeBanner: React.FC<DegradedModeBannerProps> = ({ health }) => {
  const isRpcDegraded = health.sorobanRpc.status !== 'healthy';
  const isProviderDegraded = health.fiatPayoutProvider.status !== 'healthy';

  if (!isRpcDegraded && !isProviderDegraded) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 text-amber-900 dark:text-amber-200 text-xs flex items-center justify-between"
    >
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <span className="font-semibold">Read-Only Safe Mode Active:</span>
        <span>
          {isRpcDegraded
            ? 'Stellar RPC is temporarily experiencing degraded connectivity. Transaction submissions are paused.'
            : 'Payout provider is currently undergoing maintenance. Browsing and history are active.'}
        </span>
      </div>
      <span className="text-muted-foreground font-mono">Auto-resubmit disabled</span>
    </div>
  );
};
