import { input } from "@inquirer/prompts";
import { Blaze, makeValue, Provider, Wallet } from "@blaze-cardano/sdk";
import * as Tx from "@blaze-cardano/tx";
import { Treasury } from "../../src";
import { ETransactionEvent } from "../../src/metadata/types/events";
import { IReorganize } from "../../src/metadata/types/initialize-reorganize";
import { toPermission } from "../../src/metadata/types/permission";
import { loadConfigsAndScripts } from "../../src/shared";
import {
  getActualPermission,
  getBlazeInstance,
  getConfigs,
  getOutputs,
  getSigners,
  getTransactionMetadata,
  maybeInput,
  selectUtxos,
  transactionDialog,
} from "../shared";

export async function reorganize(
  blazeInstance: Blaze<Provider, Wallet> | undefined = undefined,
): Promise<void> {
  if (!blazeInstance) {
    blazeInstance = await getBlazeInstance();
  }
  const { configs, scripts, metadata } = await getConfigs(blazeInstance);

  const {
    scripts: {
      treasuryScript: { scriptAddress: treasuryScriptAddress },
    },
  } = loadConfigsAndScripts(blazeInstance, { configs, scripts });

  const utxos = await blazeInstance.provider.getUnspentOutputs(
    treasuryScriptAddress,
  );
  const inputs = await selectUtxos(utxos);

  // Collect all native assets across the selected inputs
  const totalInputValue = inputs.reduce(
    (acc, utxo) => Tx.Value.merge(acc, utxo.output().amount()),
    Tx.Value.zero(),
  );
  const nativeAssets: [string, bigint][] = [];
  for (const [assetId, qty] of totalInputValue.multiasset() ?? []) {
    if (qty > 0n) nativeAssets.push([assetId, qty]);
  }

  const { amounts, outputs } = await getOutputs();

  // For each output, distribute native assets across outputs
  const outputAssets: [string, bigint][][] = amounts.map(() => []);
  if (nativeAssets.length > 0) {
    console.log(
      `\nThe selected inputs contain ${nativeAssets.length} native asset(s). Distribute them across your outputs.`,
    );
    for (const [assetId, totalQty] of nativeAssets) {
      let remaining = totalQty;
      for (let i = 0; i < amounts.length; i++) {
        const isLast = i === amounts.length - 1;
        const raw = await input({
          message: `Output ${i} — amount of asset ${assetId} (${remaining} remaining${isLast ? ", enter to use remainder" : ""}):`,
          default: isLast ? remaining.toString() : undefined,
          validate: (value) => {
            const n = BigInt(value || remaining.toString());
            if (n < 0n) return "Must be non-negative";
            if (n > remaining) return `Cannot exceed remaining ${remaining}`;
            return true;
          },
        });
        const assigned = BigInt(raw || remaining.toString());
        outputAssets[i].push([assetId, assigned]);
        remaining -= assigned;
      }
    }
  }

  const outputAmounts = amounts.map((lovelace, i) =>
    makeValue(lovelace, ...outputAssets[i]),
  );

  const reorganizePermissions = metadata
    ? getActualPermission(
        metadata.body.permissions.reorganize,
        metadata.body.permissions,
      )
    : toPermission(configs.treasury.permissions.reorganize);

  const signers = await getSigners(reorganizePermissions);

  const reason = await maybeInput({
    message: "Enter a reason for the reorganization (optional)",
  });

  const txMetadata = await getTransactionMetadata<IReorganize>(
    configs.treasury.registry_token,
    {
      event: ETransactionEvent.REORGANIZE,
      reason: reason ?? undefined,
      outputs,
    },
  );

  const tx = await Treasury.reorganize({
    configsOrScripts: { configs, scripts },
    blaze: blazeInstance,
    inputs,
    outputAmounts,
    signers: [...signers.values()],
    metadata: txMetadata,
  });

  const finalTx = await tx.complete();
  await transactionDialog(
    blazeInstance.provider.network,
    finalTx.toCbor(),
    false,
  );
}
