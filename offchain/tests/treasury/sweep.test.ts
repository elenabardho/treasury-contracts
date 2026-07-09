import {
  Address,
  AssetId,
  Ed25519KeyHashHex,
  Hash28ByteBase16,
  Script,
  Slot,
} from "@blaze-cardano/core";
import * as Data from "@blaze-cardano/data";
import { Emulator } from "@blaze-cardano/emulator";
import { Core, makeValue } from "@blaze-cardano/sdk";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  TreasuryConfiguration,
  TreasurySpendRedeemer,
} from "../../src/generated-types/contracts";
import { IConfigs, loadTreasuryScript } from "../../src/shared";
import { sweep } from "../../src/treasury/sweep";
import {
  registryToken,
  sampleTreasuryConfig,
  sampleVendorConfig,
  setupEmulator,
  sweep_key,
  Sweeper,
} from "../utilities";

describe("When sweeping", () => {
  const amount = 340_000_000_000_000n;

  let emulator: Emulator;
  let config: TreasuryConfiguration;
  let configs: IConfigs;
  let treasuryScript: Script;
  let scriptAddress: Address;
  let scriptInput: Core.TransactionUnspentOutput;
  let secondScriptInput: Core.TransactionUnspentOutput;
  let withAssetScriptInput: Core.TransactionUnspentOutput;
  let registryInput: Core.TransactionUnspentOutput;
  let refInput: Core.TransactionUnspentOutput;
  beforeEach(async () => {
    emulator = await setupEmulator();
    config = await sampleTreasuryConfig(emulator);
    configs = {
      treasury: config,
      vendor: await sampleVendorConfig(emulator),
      trace: true,
    };
    const treasury = loadTreasuryScript(Core.NetworkId.Testnet, config, true);
    treasuryScript = treasury.script.Script;
    scriptAddress = treasury.scriptAddress;
    emulator.accounts.set(treasury.rewardAccount!, amount);
    scriptInput = new Core.TransactionUnspentOutput(
      new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 0n),
      new Core.TransactionOutput(
        treasury.scriptAddress,
        makeValue(500_000_000_000n),
      ),
    );
    scriptInput.output().setDatum(Core.Datum.newInlineData(Data.Void()));
    emulator.addUtxo(scriptInput);
    secondScriptInput = new Core.TransactionUnspentOutput(
      new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 1n),
      new Core.TransactionOutput(
        treasury.scriptAddress,
        makeValue(1_000_000_000n),
      ),
    );
    secondScriptInput.output().setDatum(Core.Datum.newInlineData(Data.Void()));
    emulator.addUtxo(secondScriptInput);
    withAssetScriptInput = new Core.TransactionUnspentOutput(
      new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 2n),
      new Core.TransactionOutput(
        treasury.scriptAddress,
        makeValue(1_000_000_000n, ["a".repeat(56), 1n]),
      ),
    );
    withAssetScriptInput
      .output()
      .setDatum(Core.Datum.newInlineData(Data.Void()));
    emulator.addUtxo(withAssetScriptInput);
    const [registryPolicy, registryName] = registryToken();
    registryInput = emulator.utxos().find((u) =>
      u
        .output()
        .amount()
        .multiasset()
        ?.get(AssetId(registryPolicy + registryName)),
    )!;

    refInput = emulator.lookupScript(treasury.script.Script);
  });

  describe("after the timeout", () => {
    beforeEach(() => {
      emulator.stepForwardToUnix(config.expiration + 1000n);
    });

    describe("anyone", () => {
      test("can sweep funds back to the treasury", async () => {
        await emulator.as("Anyone", async (blaze) => {
          await emulator.expectValidTransaction(
            blaze,
            await sweep({
              configsOrScripts: { configs },
              input: scriptInput,
              blaze,
            }),
          );
        });
      });

      test("can partially sweep, so long as the remainder stays locked", async () => {
        await emulator.as("Anyone", async (blaze) => {
          await emulator.expectValidTransaction(
            blaze,
            await sweep({
              configsOrScripts: { configs },
              input: scriptInput,
              blaze,
              amount: 500_000_000_000n - 5_000_000n,
            }),
          );
        });
      });

      test("can donate additional funds", async () => {
        await emulator.as("Anyone", async (blaze) => {
          await emulator.expectValidTransaction(
            blaze,
            blaze
              .newTransaction()
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .setValidFrom(emulator.unixToSlot(config.expiration + 1000n))
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .setDonation(scriptInput.output().amount().coin() + 1_000_000n),
          );
        });
      });

      test("can sweep multiple inputs at once", async () => {
        await emulator.as("Anyone", async (blaze) => {
          await emulator.expectValidTransaction(
            blaze,
            blaze
              .newTransaction()
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .addInput(
                secondScriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .setValidFrom(emulator.unixToSlot(config.expiration + 1000n))
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .setDonation(
                scriptInput.output().amount().coin() +
                  secondScriptInput.output().amount().coin(),
              ),
          );
        });
      });

      test("can sweep so long as native assets stay locked", async () => {
        await emulator.as("Anyone", async (blaze) => {
          await emulator.expectValidTransaction(
            blaze,
            blaze
              .newTransaction()
              .addInput(
                withAssetScriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .lockAssets(
                scriptAddress,
                makeValue(2_000_000n, ["a".repeat(56), 1n]),
                Data.Void(),
              )
              .setValidFrom(emulator.unixToSlot(config.expiration + 1000n))
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .setDonation(withAssetScriptInput.output().amount().coin()),
          );
        });
      });

      test("must donate all funds not re-locked at the script address", async () => {
        await emulator.as("Anyone", async (blaze) => {
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .setValidFrom(emulator.unixToSlot(config.expiration + 1000n))
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .setDonation(scriptInput.output().amount().coin() / 2n),
            /expect donation >=/,
          );
        });
      });
    });

    describe("a malicious user", () => {
      test("cannot steal from second input", async () => {
        await emulator.as("MaliciousUser", async (blaze) => {
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .addInput(
                secondScriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .setValidFrom(emulator.unixToSlot(config.expiration + 1000n))
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .setDonation(
                scriptInput.output().amount().coin() +
                  secondScriptInput.output().amount().coin() -
                  1n,
              ),
            /expect donation >=/,
          );
        });
      });
      test("cannot steal native assets", async () => {
        await emulator.as("MaliciousUser", async (blaze) => {
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .addInput(
                withAssetScriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .setValidFrom(emulator.unixToSlot(config.expiration + 1000n))
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .setDonation(withAssetScriptInput.output().amount().coin()),
            /without_lovelace\(input_sum\) == without_lovelace\(output_sum\)/,
          );
        });
      });
      test("cannot attach their own staking address", async () => {
        const fullAddress = new Core.Address({
          type: Core.AddressType.BasePaymentScriptStakeKey,
          networkId: Core.NetworkId.Testnet,
          paymentPart: {
            type: Core.CredentialType.ScriptHash,
            hash: treasuryScript.hash(),
          },
          delegationPart: {
            type: Core.CredentialType.KeyHash,
            hash: Hash28ByteBase16("0".repeat(56)), // Just use an arbitrary hash, since this is a key hash
          },
        });
        await emulator.as("MaliciousUser", async (blaze) => {
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .addInput(
                withAssetScriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .lockAssets(
                fullAddress,
                makeValue(2_000_000n, ["a".repeat(56), 1n]),
                Data.Void(),
              )
              .setValidFrom(emulator.unixToSlot(config.expiration + 1000n))
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .setDonation(withAssetScriptInput.output().amount().coin()),
            /Trace expect or {\s*allow_different_stake,/,
          );
        });
      });
    });
  });
  describe("before the timeout", () => {
    describe("the treasury oversight committee", () => {
      test("can sweep funds back to the treasury early", async () => {
        await emulator.as(Sweeper, async (blaze) => {
          await emulator.expectValidTransaction(
            blaze,
            await sweep({
              configsOrScripts: { configs },
              input: scriptInput,
              blaze,
              signers: [Ed25519KeyHashHex(await sweep_key(emulator))],
              now: new Date(emulator.slotToUnix(Slot(0))),
            }),
          );
        });
      });

      test("can partially sweep early, so long as the remainder stays locked", async () => {
        await emulator.as(Sweeper, async (blaze) => {
          await emulator.expectValidTransaction(
            blaze,
            await sweep({
              configsOrScripts: { configs },
              input: scriptInput,
              blaze,
              amount: 500_000_000_000n - 5_000_000n,
              signers: [Ed25519KeyHashHex(await sweep_key(emulator))],
              now: new Date(emulator.slotToUnix(Slot(0))),
            }),
          );
        });
      });

      test("cannot sweep early without signers", async () => {
        await emulator.as(Sweeper, async (blaze) => {
          expect(
            sweep({
              configsOrScripts: { configs },
              input: scriptInput,
              blaze,
              after: false,
            }),
          ).rejects.toThrow(/requires signers/);
        });
      });

      test("cannot sweep early too close to the expiration", async () => {
        await emulator.as(Sweeper, async (blaze) => {
          expect(
            sweep({
              configsOrScripts: { configs },
              input: scriptInput,
              blaze,
              signers: [Ed25519KeyHashHex(await sweep_key(emulator))],
              now: new Date(Number(config.expiration) - 10_000),
            }),
          ).rejects.toThrow(/expiration is too close/);
        });
      });
    });

    describe("a malicious user", () => {
      test("cannot sweep funds", async () => {
        await emulator.as("MaliciousUser", async (blaze) => {
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, "SweepTreasury"),
              )
              .setValidFrom(emulator.unixToSlot(config.expiration - 1000n))
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .setDonation(500_000_000_000n),
            /is_entirely_after\(validity_range, config.expiration\)/,
          );
        });
      });
    });
  });
});
