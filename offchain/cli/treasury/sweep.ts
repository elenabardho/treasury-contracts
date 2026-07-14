import { Ed25519KeyHashHex } from "@blaze-cardano/core";
import { Blaze, Provider, Wallet } from "@blaze-cardano/sdk";
import { confirm, input } from "@inquirer/prompts";
import { Treasury } from "../../src";
import { ITransactionMetadata } from "../../src/metadata/shared";
import { ETransactionEvent } from "../../src/metadata/types/events";
import { ISweep } from "../../src/metadata/types/sweep";
import {
  getBlazeInstance,
  getConfigs,
  getOptional,
  getSigners,
  getTransactionMetadata,
  maybeInput,
  resolvePermission,
  selectUtxo,
  transactionDialog,
} from "../shared";

// The validator only allows up to 5 ADA of the swept input to stay behind
// (to cover minUTxO for native assets); everything else must be donated
const MAX_RETAINED_LOVELACE = 5_000_000n;

export async function sweep(
  blazeInstance: Blaze<Provider, Wallet> | undefined = undefined,
): Promise<void> {
  if (!blazeInstance) {
    blazeInstance = await getBlazeInstance();
  }
  const { configs, scripts, metadata } = await getConfigs(blazeInstance);

  let signers: Ed25519KeyHashHex[] = [];
  const expiration = Number(configs.treasury.expiration);
  const early = Date.now() <= expiration;
  if (early) {
    console.log(
      `Treasury does not expire until ${new Date(expiration).toLocaleString()}.`,
    );
    console.log(
      "Sweeping early requires the transaction to be signed by the sweep permission holders.",
    );
    const proceed = await confirm({
      message: "Continue with an early sweep?",
    });
    if (!proceed) {
      return;
    }
    const sweepPermissions = resolvePermission(
      "sweep",
      configs.treasury.permissions.sweep,
      metadata,
    );
    signers = [...(await getSigners(sweepPermissions)).values()];
    if (signers.length === 0) {
      console.log(
        "The sweep permission has no key signers the CLI can satisfy (e.g. script or time-locked conditions only); cannot build an early sweep.",
      );
      return;
    }
  }

  const { scriptAddress } = scripts.treasuryScript;
  const utxos = await blazeInstance.provider.getUnspentOutputs(scriptAddress);
  const utxo = await selectUtxo(utxos);

  const maxLovelace = utxo.output().amount().coin();
  const minLovelace =
    maxLovelace > MAX_RETAINED_LOVELACE
      ? maxLovelace - MAX_RETAINED_LOVELACE
      : 1n;
  let amount: bigint | undefined;
  while (true) {
    amount = undefined;
    const amountOpt = await getOptional(
      "Do you want to specify an amount to sweep? (default: all lovelace)",
      {
        message: `Enter amount in lovelace (${minLovelace} to ${maxLovelace}; at most 5 ADA may stay at the script):`,
      },
      input,
    );
    if (amountOpt === undefined) {
      break;
    }
    try {
      amount = BigInt(amountOpt);
    } catch {
      console.log(`"${amountOpt}" is not a valid lovelace amount.`);
      continue;
    }
    if (amount >= minLovelace && amount <= maxLovelace) {
      break;
    }
    console.log(
      `Amount must be between ${minLovelace} and ${maxLovelace} lovelace, so that at most 5 ADA stays at the script address.`,
    );
  }

  // The metadata spec treats sweep metadata as optional: attach it when there
  // is something worth explaining, which is almost always the case for an
  // early sweep
  let txMetadata: ITransactionMetadata<ISweep> | undefined;
  const attachMetadata = await confirm({
    message: early
      ? "Attach transaction metadata explaining this early sweep? (recommended)"
      : "Attach transaction metadata explaining this sweep?",
    default: early,
  });
  if (attachMetadata) {
    const body: ISweep = {
      event: ETransactionEvent.SWEEP,
      projectIdentifier: await maybeInput({
        message:
          "Project identifier from the fund event, if this surplus relates to a funded project (optional):",
      }),
      milestones: await maybeInput({
        message:
          "Milestone identifiers the surplus originated from, comma separated (optional):",
      }).then((s) =>
        s
          ? s
              .split(",")
              .map((m) => m.trim())
              .filter((m) => m.length > 0)
          : undefined,
      ),
      comment: await maybeInput({
        message: "Why are the funds being swept now? (optional)",
      }),
    };
    txMetadata = await getTransactionMetadata(
      configs.treasury.registry_token,
      body,
    );
  }

  const tx = await Treasury.sweep({
    configsOrScripts: { configs, scripts },
    input: utxo,
    blaze: blazeInstance,
    amount,
    signers,
    after: !early,
    metadata: txMetadata,
  });
  const finalTx = await tx.complete();
  await transactionDialog(
    blazeInstance.provider.network,
    finalTx.toCbor().toString(),
    false,
  );
}
