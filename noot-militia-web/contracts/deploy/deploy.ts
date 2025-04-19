import * as hre from "hardhat";
import { vars } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { Deployer } from "@matterlabs/hardhat-zksync";
import { Provider, types, utils, Wallet } from "zksync-ethers";
import { Contract, ContractTransactionReceipt, parseEther } from "ethers";
import { EIP712_TYPES, EIP712Signer } from "zksync-ethers/build/signer";
import { EIP712_TX_TYPE, serializeEip712 } from "zksync-ethers/build/utils";
import { TransactionRequest } from "zksync-ethers/build/types";

import "@matterlabs/hardhat-zksync-verify/dist/src/type-extensions";
import "@matterlabs/hardhat-zksync-node/dist/type-extensions";

// An example of a deploy script that will deploy and call a simple contract.
export default async function deploy(hre: HardhatRuntimeEnvironment) {
  console.log(`Running deploy script...`);

  // Setup the EOA wallet to deploy from (reads private key from hardhat config)
  const provider = new Provider(hre.network.config.url);
  const eoaWallet = new Wallet(vars.get("WALLET_PRIVATE_KEY"), provider);
  const eoaWalletAddress = await eoaWallet.getAddress();
  const deployer = new Deployer(hre, eoaWallet);

  // === 1: Deploy Account Implementation ======================================================== \\
  
  // First deploy the Account implementation contract directly
  const accountArtifact = await deployer.loadArtifact("Account");
  const accountDeployment = await deployer.deploy(
    accountArtifact,
    [eoaWalletAddress], // Constructor args: owner address
    undefined, // Options
    undefined, // Bytecode override
    [] // Dependencies - empty since we're deploying the implementation directly
  );
  
  const accountContract = await accountDeployment.waitForDeployment();
  const accountAddress = await accountContract.getAddress();
  
  console.log(`✅ Account implementation deployed at: ${accountAddress}`);
  logExplorerUrl(accountAddress, "address");
  
  // Compute the bytecode hash in the way that zksync expects
  const bytecodeWithoutConstructor = accountArtifact.bytecode;
  const accountBytecodeHash = utils.hashBytecode(bytecodeWithoutConstructor);
  
  console.log(`Generated bytecode hash: ${accountBytecodeHash}`);
  
  // === 2: Validate the bytecode is registered on zksync ======================================== \\
  let bytecodeHexString = "";
  try {
    bytecodeHexString = `0x${Array.from(accountBytecodeHash)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')}`;
    console.log(`Bytecode hash in hex: ${bytecodeHexString}`);
    
    // This will throw if the bytecode is not registered
    const isDeployed = await provider.getBytecodeByHash(bytecodeHexString);
    console.log(`✅ Bytecode is registered on zksync: ${isDeployed ? "Yes" : "No"}`);
  } catch (error) {
    console.error(`Error checking bytecode registration:`, error);
    // Continue anyway since we've deployed the implementation
  }

  // === 3: Deploy Factory ======================================================================== \\

  const factoryConstructorArgs = [accountBytecodeHash];
  const factoryArtifact = await deployer.loadArtifact("AccountFactory");
  const factoryDeployment = await deployer.deploy(
    factoryArtifact,
    factoryConstructorArgs,
    undefined,
    undefined,
    [bytecodeWithoutConstructor] // Pass account bytecode as dependency
  );

  const factoryContract = await factoryDeployment.waitForDeployment();
  const factoryContractAddress = await factoryContract.getAddress();

  await verifyContract({
    address: factoryContractAddress,
    constructorArguments: factoryContract.interface.encodeDeploy(
      factoryConstructorArgs
    ),
    bytecode: factoryArtifact.bytecode,
    contract: `${factoryArtifact.sourceName}:${factoryArtifact.contractName}`,
  });

  console.log(`✅ Factory contract deployed at: ${factoryContractAddress}`);
  logExplorerUrl(factoryContractAddress, "address");

  // === 4: Deploy Account directly using the system contract ===================================== \\
  console.log("Attempting to deploy account directly using system contract...");
  
  // Generate a salt for the deployment - ensure uniqueness by using timestamp
  const timestamp = Date.now().toString();
  const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("account-" + timestamp));
  console.log(`Using salt: ${salt}`);
  
  // Encode constructor arguments for the account
  const encodedConstructorArgs = hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["address"], // Constructor parameter types
    [eoaWalletAddress] // Constructor parameter values
  );
  
  // Create a transaction to deploy the contract directly using the system contract
  const deployerSystemContract = "0x0000000000000000000000000000000000008006"; // DEPLOYER_SYSTEM_CONTRACT address
  
  const deployerInterface = new hre.ethers.Interface([
    "function create2Account(bytes32 salt, bytes32 bytecodeHash, bytes calldata input, uint8 aaVersion) external returns (address)"
  ]);
  
  try {
    const deployTx = await eoaWallet.sendTransaction({
      to: deployerSystemContract,
      data: deployerInterface.encodeFunctionData("create2Account", [
        salt,
        bytecodeHexString, // Using the hex string bytecode hash
        encodedConstructorArgs,
        1 // AA version 1
      ])
    });
    
    console.log(`Direct deployment transaction sent: ${deployTx.hash}`);
    logExplorerUrl(deployTx.hash, "tx");
    
    const deployReceipt = await deployTx.wait();
    console.log(`Transaction status: ${deployReceipt?.status === 1 ? "Success" : "Failed"}`);
    
    // Look for the deployed address in the transaction logs
    console.log("Analyzing transaction receipt for created address...");
    
    // The create2Account function returns the deployed address
    // We can compute it using create2 formula
    const create2Formula = (salt: string, bytecodeHash: string, input: string) => {
      // Compute the address using create2 formula
      const prefix = "0x";
      const ff = "0xff";
      const deployer = deployerSystemContract.toLowerCase();
      
      const hashInput = hre.ethers.concat([
        hre.ethers.toUtf8Bytes(ff),
        hre.ethers.toUtf8Bytes(deployer.slice(2)),
        hre.ethers.getBytes(salt),
        hre.ethers.getBytes(bytecodeHexString),
        hre.ethers.keccak256(hre.ethers.getBytes(encodedConstructorArgs))
      ]);
      
      const hash = hre.ethers.keccak256(hashInput);
      // Take last 20 bytes of the hash and prefix with 0x
      return prefix + hash.slice(26);
    };
    
    // Compute the expected address
    const expectedAddress = create2Formula(salt, bytecodeHexString, encodedConstructorArgs);
    console.log(`Computed expected address: ${expectedAddress}`);
    
    // Verify the address has code
    const code = await provider.getCode(expectedAddress);
    if (code !== '0x') {
      console.log(`✅ Found code at computed address: ${expectedAddress}`);
      logExplorerUrl(expectedAddress, "address");
      
      // Use this address for further operations
      await tryUsingAccount(expectedAddress, eoaWallet, provider, accountArtifact);
      return;
    } else {
      console.log(`❌ No code found at computed address: ${expectedAddress}`);
    }
    
    // If we couldn't find the address using create2 formula, try to extract it from logs
    if (deployReceipt && deployReceipt.logs) {
      console.log(`Found ${deployReceipt.logs.length} logs in the transaction receipt`);
      
      // Define system contract addresses to exclude
      const systemContracts = [
        "0x0000000000000000000000000000000000008001", // Bootloader
        "0x0000000000000000000000000000000000008002", // AccountCodeStorage
        "0x0000000000000000000000000000000000008003", // NonceHolder
        "0x0000000000000000000000000000000000008004", // KnownCodesStorage
        "0x0000000000000000000000000000000000008005", // ImmutableSimulator
        "0x0000000000000000000000000000000000008006", // ContractDeployer
        "0x0000000000000000000000000000000000008007", // L1Messenger
        "0x0000000000000000000000000000000000008008", // MsgValueSimulator
        "0x0000000000000000000000000000000000008009", // L2EthToken
        "0x000000000000000000000000000000000000800A", // SystemContext
        "0x000000000000000000000000000000000000800B", // BootloaderUtilities
        "0x000000000000000000000000000000000000800C", // EventWriter
        "0x000000000000000000000000000000000000800D", // CompressorContract
        "0x000000000000000000000000000000000000800E", // ComplexUpgrader
        "0x000000000000000000000000000000000000800F", // Ecrecover
        "0x0000000000000000000000000000000000008010", // SHA256
      ].map(addr => addr.toLowerCase());
      
      // Try to find the ContractDeployed event from the deployer
      // This event should contain the deployed contract address
      const contractDeployedEvent = deployReceipt.logs.find(log => {
        // Check if it's from the deployer system contract
        if (log.address.toLowerCase() !== deployerSystemContract.toLowerCase()) {
          return false;
        }
        
        // Check if it has the right topic (ContractDeployed event)
        // The event signature is: ContractDeployed(address indexed deployer, bytes32 indexed bytecodeHash, address indexed contractAddress)
        const contractDeployedTopic = "0x290afdae231a3fc0bbae8b1af63698b0a1d79b21ad17df0342dfb952fe74f8e5";
        return log.topics[0] === contractDeployedTopic;
      });
      
      if (contractDeployedEvent) {
        // The contract address should be in the third topic (index 2)
        const deployedAddress = "0x" + contractDeployedEvent.topics[2].slice(26);
        console.log(`Found deployed address in ContractDeployed event: ${deployedAddress}`);
        
        // Verify this address has code
        const code = await provider.getCode(deployedAddress);
        if (code !== '0x') {
          console.log(`✅ Found code at address from event: ${deployedAddress}`);
          logExplorerUrl(deployedAddress, "address");
          
          // Use this address for further operations
          await tryUsingAccount(deployedAddress, eoaWallet, provider, accountArtifact);
          return;
        }
      }
      
      // If we still couldn't find the address, try a different approach
      // Look for any address in the logs that has code and is not a system contract
      console.log("Trying to find any address in logs that has code (excluding system contracts)...");
      
      for (const log of deployReceipt.logs) {
        // Check if the log address itself has code (might be the deployed contract)
        if (log.address && !systemContracts.includes(log.address.toLowerCase())) {
          const code = await provider.getCode(log.address);
          if (code !== '0x') {
            console.log(`✅ Found code at log address: ${log.address}`);
            logExplorerUrl(log.address, "address");
            
            // Use this address for further operations
            await tryUsingAccount(log.address, eoaWallet, provider, accountArtifact);
            return;
          }
        }
        
        // Check addresses in topics
        if (log.topics) {
          for (const topic of log.topics) {
            if (topic.length === 66) {  // 32 bytes + '0x'
              const potentialAddress = '0x' + topic.slice(26);  // Last 20 bytes
              if (hre.ethers.isAddress(potentialAddress) && !systemContracts.includes(potentialAddress.toLowerCase())) {
                const code = await provider.getCode(potentialAddress);
                if (code !== '0x') {
                  console.log(`✅ Found code at address from topic: ${potentialAddress}`);
                  logExplorerUrl(potentialAddress, "address");
                  
                  // Use this address for further operations
                  await tryUsingAccount(potentialAddress, eoaWallet, provider, accountArtifact);
                  return;
                }
              }
            }
          }
        }
      }
    }
    
    // If we still couldn't find the address, try using the factory as a fallback
    console.log("Could not determine the deployed account address from direct deployment");
    console.log("Falling back to factory deployment...");
    await tryFactoryDeployment(factoryContract, eoaWallet, provider, accountArtifact);
    
  } catch (error) {
    console.error("Error during direct deployment:", error);
    console.log("Falling back to factory deployment...");
    await tryFactoryDeployment(factoryContract, eoaWallet, provider, accountArtifact);
  }
}

async function tryFactoryDeployment(
  factoryContract: Contract,
  ownerWallet: Wallet,
  provider: Provider,
  accountArtifact: any
) {
  try {
    // Generate a unique salt
    const timestamp = Date.now().toString();
    const salt = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("factory-" + timestamp));
    console.log(`Using factory deployment with salt: ${salt}`);
    
    // Fix the factory contract implementation
    console.log("Checking factory contract implementation...");
    
    // Get the bytecode hash from the factory
    const storedBytecodeHash = await factoryContract.accountBytecodeHash();
    console.log(`Stored bytecode hash in factory: ${storedBytecodeHash}`);
    
    // Prepare the transaction with a high gas limit
    const ownerAddress = await ownerWallet.getAddress();
    
    // Use a fixed high gas limit instead of estimation
    const gasLimit = hre.ethers.parseUnits("5000000", "wei");
    console.log(`Using fixed gas limit: ${gasLimit}`);
    
    // Send the transaction
    const tx = await factoryContract.deployAccount(
      ownerAddress,
      salt,
      { gasLimit }
    );
    
    console.log(`Factory deployment transaction sent: ${tx.hash}`);
    logExplorerUrl(tx.hash, "tx");
    
    const receipt = await tx.wait();
    console.log(`Transaction status: ${receipt?.status === 1 ? "Success" : "Failed"}`);
    
    // Try to extract the account address from the event logs
    if (receipt && receipt.logs && receipt.logs.length > 0) {
      console.log(`Found ${receipt.logs.length} logs in the transaction receipt`);
      
      // Find the AccountCreated event from the factory
      const factoryAddress = await factoryContract.getAddress();
      const accountCreatedLogs = receipt.logs.filter(log => 
        log.address.toLowerCase() === factoryAddress.toLowerCase()
      );
      
      if (accountCreatedLogs.length > 0) {
        console.log(`Found ${accountCreatedLogs.length} logs from the factory contract`);
        
        // Try to decode the event
        try {
          for (const log of accountCreatedLogs) {
            try {
              // Parse the log using the factory interface
              const event = factoryContract.interface.parseLog({
                topics: log.topics as string[],
                data: log.data
              });
              
              if (event && event.name === "AccountCreated") {
                const accountAddress = event.args[0];
                console.log(`✅ Account deployed via factory at: ${accountAddress}`);
                logExplorerUrl(accountAddress, "address");
                
                // Try to use this address
                await tryUsingAccount(accountAddress, ownerWallet, provider, accountArtifact);
                return;
              }
            } catch (e) {
              console.log("Failed to parse log:", e);
            }
          }
        } catch (e) {
          console.error("Error decoding event:", e);
        }
      }
    }
    
    console.log("Could not determine the deployed account address from logs");
    
  } catch (error) {
    console.error("Error during factory deployment:", error);
  }
}

async function tryUsingAccount(
  accountAddress: string,
  ownerWallet: Wallet,
  provider: Provider,
  accountArtifact: any
) {
  try {
    // Check for code at the address
    const code = await provider.getCode(accountAddress);
    if (code === '0x') {
      console.log(`❌ No code at address: ${accountAddress}`);
      return;
    }
    
    console.log(`✅ Found code at address: ${accountAddress}`);
    
    // Create account contract instance
    const accountContract = new Contract(
      accountAddress,
      accountArtifact.abi,
      ownerWallet
    );
    
    // Check if the account has the right owner
    try {
      const owner = await accountContract.owner();
      console.log(`Account owner: ${owner}`);
      const expectedOwner = await ownerWallet.getAddress();
      if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
        console.log(`⚠️ Warning: Account owner (${owner}) doesn't match expected owner (${expectedOwner})`);
      } else {
        console.log(`✅ Account owner matches expected owner`);
      }
    } catch (e) {
      console.error("Error checking account owner:", e);
    }
    
    // Fund the account
    console.log("Funding the account...");
    await loadFundsToAccount(ownerWallet, accountAddress, parseEther("0.001"));
    
    // Try to send a transaction from the account
    await sendTransactionFromAccount(ownerWallet, accountAddress, provider, accountArtifact);
  } catch (error) {
    console.error("Error using account:", error);
  }
}

async function sendTransactionFromAccount(
  ownerWallet: Wallet,
  accountAddress: string,
  provider: Provider,
  accountArtifact: any
) {
  try {
    const to = "0x8e729E23CDc8bC21c37a73DA4bA9ebdddA3C8B6d";
    const nonce = await provider.getTransactionCount(accountAddress);
    const gasPrice = await provider.getGasPrice();
    
    // Use a hardcoded gas limit if estimation fails
    let gasLimit;
    try {
      gasLimit = await provider.estimateGas({
        from: accountAddress,
        to,
        data: "0x69",
      });
    } catch (e) {
      console.log("Gas estimation failed, using default gas limit");
      gasLimit = 500000n;
    }

    console.log(`Creating transaction with nonce: ${nonce}`);
    
    // Create your transaction object
    const tx: TransactionRequest = {
      from: accountAddress, // Smart contract address
      to: to,
      data: "0x69",
      nonce: nonce,
      gasLimit: gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      chainId: (await provider.getNetwork()).chainId,
      value: 0,
      type: EIP712_TX_TYPE,
      customData: {
        gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
      } as types.Eip712Meta,
    };

    // Transform the transaction into an EIP712 typed data object
    const typedData = EIP712Signer.getSignInput(tx);

    // Sign the typed data with the EOA wallet
    const rawSignature = await ownerWallet.signTypedData(
      {
        name: "zkSync",
        version: "2",
        chainId: (await provider.getNetwork()).chainId,
      },
      EIP712_TYPES,
      typedData
    );

    // Serialize the transaction with the custom signature
    const serializedTx = serializeEip712({
      ...tx,
      to: to,
      from: accountAddress,
      customData: {
        ...tx.customData,
        customSignature: rawSignature,
      },
    });

    console.log("Submitting transaction from smart account...");
    const transactionRequest = await provider.broadcastTransaction(serializedTx);
    const transactionResponse = await transactionRequest.wait();

    console.log(
      `✅ Transaction submitted from smart contract: ${transactionResponse.hash}`
    );
    logExplorerUrl(transactionResponse.hash, "tx");
    
    return transactionResponse;
  } catch (error) {
    console.error("Error sending transaction from account:", error);
    throw error;
  }
}

const verifyContract = async (data: {
  address: string;
  contract: string;
  constructorArguments: string;
  bytecode: string;
}) => {
  if (hre.network.name === "abstractTestnet") {
    try {
      const verificationRequestId: number = await hre.run("verify:verify", {
        ...data,
        noCompile: true,
      });
      return verificationRequestId;
    } catch (error) {
      console.warn("Verification failed:", error);
      return null;
    }
  }
  return null;
};

function logExplorerUrl(address: string, type: "address" | "tx") {
  if (hre.network.name === "abstractTestnet") {
    const explorerUrl = `https://explorer.testnet.abs.xyz/${type}/${address}`;
    const prettyType = type === "address" ? "account" : "transaction";

    console.log(
      `🔗 View your ${prettyType} on the Abstract Explorer: ${explorerUrl}\n`
    );
  }
}

async function loadFundsToAccount(
  senderWallet: Wallet,
  smartAccountAddress: string,
  amount: bigint
) {
  try {
    const tx = await senderWallet.transfer({
      amount,
      to: smartAccountAddress,
    });
    console.log(`Funding transaction submitted: ${tx.hash}`);
    await tx.wait();
    console.log(`✅ Successfully loaded ${hre.ethers.formatEther(amount)} ETH to smart account`);
    return tx;
  } catch (e) {
    console.error("Error loading funds to smart account:", e);
    throw e;
  }
}