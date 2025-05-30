// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
//tested 

/**
 * @title GameAssetMarketplace
 * @dev A marketplace contract for game assets (gun skins, character skins) as NFTs
 * Owner can create assets, users can purchase them, and payments are sent to a PayMaster
 */
contract GameAssetMarketplace is ERC721URIStorage, Ownable {
    // Replace Counters with a simple uint256
    uint256 private _currentTokenId;
    
    // PayMaster address to receive all payments
    address public payMaster;
    
    // Asset types
    enum AssetType { GUN_SKIN, CHARACTER_SKIN }
    
    // Asset struct to store asset details
    struct GameAsset {
        uint256 id;
        string name;
        string description;
        AssetType assetType;
        uint256 price;
        bool isForSale;
    }
    
    // Mapping from token ID to GameAsset
    mapping(uint256 => GameAsset) public gameAssets;
    
    // Events
    event AssetCreated(uint256 indexed tokenId, string name, AssetType assetType, uint256 price);
    event AssetPurchased(uint256 indexed tokenId, address indexed buyer, uint256 price);
    event PayMasterUpdated(address indexed oldPayMaster, address indexed newPayMaster);
    event DebugStep(string message, uint256 tokenId);
    
    /**
     * @dev Constructor initializes the contract with a name and symbol
     * PayMaster can be set later using setPayMaster function
     */
    constructor() ERC721("GameAssets", "GASSET") Ownable(msg.sender) {
        // Initialize the token counter to 0
        _currentTokenId = 0;
    }
    
    /**
     * @dev Set a new PayMaster address
     * @param _newPayMaster Address of the new PayMaster
     */
    function setPayMaster(address _newPayMaster) external onlyOwner {
        require(_newPayMaster != address(0), "PayMaster address cannot be zero");
        emit PayMasterUpdated(payMaster, _newPayMaster);
        payMaster = _newPayMaster;
    }
    
    /**
     * @dev Create a new game asset (can only be called by owner)
     * @param name Name of the asset
     * @param description Description of the asset
     * @param assetType Type of asset (GUN_SKIN or CHARACTER_SKIN)
     * @param price Price in wei
     * @param metadataURI URI for the token metadata
     * @return tokenId of the created asset
     */
    function createGameAsset(
        string memory name,
        string memory description,
        AssetType assetType,
        uint256 price,
        string memory metadataURI
    ) external onlyOwner returns (uint256) {
        emit DebugStep("Starting asset creation", 0);
        
        // Increment token ID
        _currentTokenId += 1;
        uint256 newTokenId = _currentTokenId;
        emit DebugStep("Token ID incremented", newTokenId);
        
        // Mint the token to msg.sender instead of the contract
        _safeMint(msg.sender, newTokenId);
        emit DebugStep("Token minted", newTokenId);
        
        _setTokenURI(newTokenId, metadataURI);
        emit DebugStep("Token URI set", newTokenId);
        
        // Create and store the asset details
        gameAssets[newTokenId] = GameAsset({
            id: newTokenId,
            name: name,
            description: description,
            assetType: assetType,
            price: price,
            isForSale: true
        });
        emit DebugStep("Asset details stored", newTokenId);
        
        emit AssetCreated(newTokenId, name, assetType, price);
        return newTokenId;
    }
    
    /**
     * @dev Purchase an asset and transfer it to the user's smart account
     * @param tokenId ID of the asset to purchase
     * @param userSmartAccountAddress Address of the user's smart account to receive the NFT
     */
    function purchaseAsset(uint256 tokenId, address userSmartAccountAddress) external payable {
        // Check if PayMaster is set
        require(payMaster != address(0), "PayMaster not set");
        
        GameAsset storage asset = gameAssets[tokenId];
        require(asset.id == tokenId, "Asset does not exist");
        require(asset.isForSale, "Asset is not for sale");
        require(msg.value >= asset.price, "Insufficient payment");
        require(userSmartAccountAddress != address(0), "Invalid smart account address");
        
        // Mark as sol
        asset.isForSale = false;
        
        // Transfer the NFT from the owner to the user's smart account
        address tokenOwner = ownerOf(tokenId);
        _transfer(tokenOwner, userSmartAccountAddress, tokenId);
        
        // Forward the payment to PayMaster
        (bool success, ) = payMaster.call{value: msg.value}("");
        require(success, "Payment transfer failed");
        
        emit AssetPurchased(tokenId, userSmartAccountAddress, asset.price);
    }
    
    /**
     * @dev Returns all available assets for sale
     * @return Array of available asset IDs
     */
    function getAvailableAssets() external view returns (uint256[] memory) {
        uint256 totalAssets = _currentTokenId;
        uint256 availableCount = 0;
        
        // First, count available assets
        for (uint256 i = 1; i <= totalAssets; i++) {
            if (gameAssets[i].isForSale) {
                availableCount++;
            }
        }
        
        // Then populate the array
        uint256[] memory availableAssets = new uint256[](availableCount);
        uint256 currentIndex = 0;
        
        for (uint256 i = 1; i <= totalAssets; i++) {
            if (gameAssets[i].isForSale) {
                availableAssets[currentIndex] = i;
                currentIndex++;
            }
        }
        
        return availableAssets;
    }
    
    /**
     * @dev Get details of a specific asset
     * @param tokenId ID of the asset
     * @return Asset details
     */
    function getAssetDetails(uint256 tokenId) external view returns (GameAsset memory) {
        require(gameAssets[tokenId].id == tokenId, "Asset does not exist");
        return gameAssets[tokenId];
    }
    
    /**
     * @dev Withdraw any ETH accidentally sent to this contract (can only be called by owner)
     */
    function withdrawEth() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        
        // If PayMaster is not set, send to owner
        address recipient = payMaster != address(0) ? payMaster : owner();
        
        (bool success, ) = recipient.call{value: balance}("");
        require(success, "Withdrawal failed");
    }
}