import {
  AssetId,
  AuxiliaryData,
  Ed25519KeyHashHex,
  NetworkId,
  PlutusData,
  Script,
  Slot,
  toHex,
  TransactionUnspentOutput,
  Value,
} from "@blaze-cardano/core";
import * as Data from "@blaze-cardano/data";
import {
  TxBuilder,
  type Blaze,
  type Provider,
  type Wallet,
} from "@blaze-cardano/sdk";

import { TreasurySpendRedeemer } from "../../generated-types/contracts.js";
import { ITransactionMetadata, toTxMetadata } from "../../metadata/shared.js";
import { IReorganize } from "../../metadata/types/initialize-reorganize.js";
import {
  attachScriptRef,
  loadConfigsAndScripts,
  rewardAccountFromScript,
  TConfigsOrScripts,
} from "../../shared/index.js";

export interface IReorganizeArgs<P extends Provider, W extends Wallet> {
  configsOrScripts: TConfigsOrScripts;
  blaze: Blaze<P, W>;
  inputs: TransactionUnspentOutput[];
  outputAmounts: Value[];
  signers: Ed25519KeyHashHex[];
  additionalScripts?: { script: Script; redeemer: PlutusData }[];
  metadata?: ITransactionMetadata<IReorganize>;
}

export async function reorganize<P extends Provider, W extends Wallet>({
  configsOrScripts,
  blaze,
  inputs,
  outputAmounts,
  signers,
  additionalScripts,
  metadata,
}: IReorganizeArgs<P, W>): Promise<TxBuilder> {
  const { configs, scripts } = loadConfigsAndScripts(blaze, configsOrScripts);
  const { scriptAddress } = scripts.treasuryScript;
  const registryInput = await blaze.provider.getUnspentOutputByNFT(
    AssetId(configs.treasury.registry_token + toHex(Buffer.from("REGISTRY"))),
  );
  const maxHorizon = blaze.provider.network === NetworkId.Testnet ? 6 : 36;
  const upperBoundUnix = Math.min(
    Number(configs.treasury.expiration),
    Date.now() + maxHorizon * 60 * 60 * 1000,
  );
  const upperBoundSlot = blaze.provider.unixToSlot(upperBoundUnix) - 30;

  let tx = blaze
    .newTransaction()
    .setValidUntil(Slot(upperBoundSlot))
    .addReferenceInput(registryInput);
  tx = await attachScriptRef(tx, scripts.treasuryScript, blaze);

  if (metadata) {
    const auxData = new AuxiliaryData();
    auxData.setMetadata(toTxMetadata(metadata));
    tx = tx.setAuxiliaryData(auxData);
  }

  if (!!additionalScripts) {
    for (const { script, redeemer } of additionalScripts) {
      const refInput = await blaze.provider.resolveScriptRef(script);
      if (!refInput) {
        throw new Error(
          `Could not find one of the additional scripts provided on-chain: ${script.hash()}. Please publish the script and try again.`,
        );
      }
      tx = tx
        .addReferenceInput(refInput)
        .addWithdrawal(
          rewardAccountFromScript(script, blaze.provider.network),
          0n,
          redeemer,
        );
    }
  }

  for (const signer of signers) {
    tx = tx.addRequiredSigner(signer);
  }

  for (const input of inputs) {
    tx = tx.addInput(
      input,
      Data.serialize(TreasurySpendRedeemer, "Reorganize"),
    );
  }

  for (const outputAmount of outputAmounts) {
    tx = tx.lockAssets(scriptAddress, outputAmount, Data.Void());
  }

  return tx;
}
