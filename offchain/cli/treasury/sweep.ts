import { Ed25519KeyHashHex } from "@blaze-cardano/core";
import { Blaze, Provider, Wallet } from "@blaze-cardano/sdk";
import { confirm, input } from "@inquirer/prompts";
import { Treasury } from "../../src";
import {
  getBlazeInstance,
  getConfigs,
  getOptional,
  getSigners,
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

  const tx = await Treasury.sweep({
    configsOrScripts: { configs, scripts },
    input: utxo,
    blaze: blazeInstance,
    amount,
    signers,
    after: !early,
  });
  const finalTx = await tx.complete();
  await transactionDialog(
    blazeInstance.provider.network,
    finalTx.toCbor().toString(),
    false,
  );
}
