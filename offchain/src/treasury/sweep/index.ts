import {
  AssetId,
  Ed25519KeyHashHex,
  toHex,
  TransactionUnspentOutput,
} from "@blaze-cardano/core";
import * as Data from "@blaze-cardano/data";
import {
  makeValue,
  TxBuilder,
  Value,
  type Blaze,
  type Provider,
  type Wallet,
} from "@blaze-cardano/sdk";

import { TreasurySpendRedeemer } from "../../generated-types/contracts.js";
import {
  attachScriptRef,
  horizonCappedValidUntilSlot,
  loadConfigsAndScripts,
  TConfigsOrScripts,
} from "../../shared/index.js";

export interface ISweepArgs<P extends Provider, W extends Wallet> {
  configsOrScripts: TConfigsOrScripts;
  input: TransactionUnspentOutput;
  blaze: Blaze<P, W>;
  amount?: bigint;
  signers?: Ed25519KeyHashHex[];
  // Sweep after the expiration (permissionless); defaults to true unless signers are provided
  after?: boolean;
  now?: Date;
}

export async function sweep<P extends Provider, W extends Wallet>({
  configsOrScripts,
  input,
  blaze,
  amount,
  signers,
  after,
  now,
}: ISweepArgs<P, W>): Promise<TxBuilder> {
  const { configs, scripts } = loadConfigsAndScripts(blaze, configsOrScripts);
  amount ??= input.output().amount().coin();
  after ??= !signers || signers.length === 0;
  const { scriptAddress } = scripts.treasuryScript;
  const registryInput = await blaze.provider.getUnspentOutputByNFT(
    AssetId(configs.treasury.registry_token + toHex(Buffer.from("REGISTRY"))),
  );
  let tx = blaze
    .newTransaction()
    .addInput(input, Data.serialize(TreasurySpendRedeemer, "SweepTreasury"))
    .addReferenceInput(registryInput)
    .setDonation(amount);
  if (!after) {
    // Sweeping before the expiration requires the sweep permission to be satisfied
    if (!signers || signers.length === 0) {
      throw new Error(
        "Sweeping before the expiration requires signers that can satisfy the sweep permission",
      );
    }
    const nowUnix = (now ?? new Date()).valueOf();
    const validUntil = horizonCappedValidUntilSlot(
      blaze.provider,
      configs.treasury.expiration - 1000n,
      nowUnix,
    );
    if (validUntil <= blaze.provider.unixToSlot(nowUnix)) {
      throw new Error(
        "The treasury expiration is too close to sweep early; wait for the expiration and sweep without signers instead",
      );
    }
    tx = tx
      .setValidFrom(blaze.provider.unixToSlot(nowUnix))
      .setValidUntil(validUntil);
    for (const signer of signers) {
      tx = tx.addRequiredSigner(signer);
    }
  } else {
    tx = tx.setValidFrom(
      blaze.provider.unixToSlot(Number(configs.treasury.expiration + 1000n)),
    );
  }
  tx = await attachScriptRef(tx, scripts.treasuryScript, blaze);

  const remainder = Value.merge(input.output().amount(), makeValue(-amount));
  if (!Value.empty(remainder)) {
    tx = tx.lockAssets(scriptAddress, remainder, Data.Void());
  }

  return tx;
}
