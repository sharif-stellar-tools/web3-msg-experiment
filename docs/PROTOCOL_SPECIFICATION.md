# Web3-Msg-Experiment: Protocol Specification & Security Model

## 1. Executive Summary & Protocol Overview

`web3-msg-experiment` is a decentralized, secure peer-to-peer messaging and data relay protocol designed for cross-chain communications across the Stellar network, EVM-compatible ecosystems, and decentralized storage networks (IPFS/libp2p). The protocol provides cryptographic guarantees of confidentiality, data integrity, non-repudiation, and forward-looking tamper resistance for off-chain message settlement.

---

## 2. Protocol Architecture

The protocol decouples payload dissemination from state anchoring by utilizing a multi-layered hybrid architecture:

1. **Application & Client Layer**: Manages keypairs, constructs message payloads, signs structured data envelopes, and decrypts inbound communications.
2. **Cryptographic Identity Layer**: Supports both Stellar Ed25519 keypairs and Ethereum/EVM EIP-712 typed signatures to enforce strict domain separation and authentication.
3. **P2P Transport & Mesh Layer**: Employs libp2p Gossipsub v1.2 for decentralized pub/sub propagation and Kademlia DHT for peer discovery and node addressing.
4. **Decentralized Storage & Caching Layer**: Offloads large payloads and historical message logs to content-addressed IPFS blocks, maintaining lightweight network packets.

### 2.1 Architectural Flow Diagram

```mermaid
flowchart TD
    subgraph Sender Node
        A[Client Application] -->|Draft Message| B[EIP-712 / Stellar Encoder]
        B -->|Structured Envelope| C[Payload Encryptor (AES-GCM / ECIES)]
        C -->|Ciphertext| D[Signature Generator]
    end

    subgraph Network Transport (libp2p)
        D -->|Publish Message| E[Gossipsub Mesh Router]
        E -->|Store Blob (>64KB)| F[(IPFS Pinning / Node)]
        E -->|Gossip Dissemination| G[Relay / Validator Nodes]
        G -->|Topic Delivery| H[Recipient Peer Discovery (DHT)]
    end

    subgraph Recipient Node
        H -->|Receive Packet| I[Envelope Unpacker]
        I -->|Verify Signature & Nonce| J{Signature Valid?}
        J -- No --> K[Drop Packet & Slash Peer Score]
        J -- Yes --> L[Decrypt Payload with Private Key]
        L --> M[Deliver to User Interface / Service]
    end
```

---

## 3. Cryptographic Framework & Standards

### 3.1 Envelope Structure & Domain Separation
All network transmissions wrap payloads inside a strongly-typed schema to prevent cross-protocol collision and signature malleability:

```typescript
interface MessageEnvelope {
  protocolVersion: string; // e.g. "web3-msg/1.0"
  messageId: string;       // SHA-256 digest of ciphertext + nonce
  sender: string;          // Hex/Base32 address of sender
  recipient: string;       // Target address or topic hash
  timestamp: number;       // Unix epoch milliseconds
  nonce: number;           // Monotonically increasing sequential nonce
  contentType: string;     // MIME-type identifier (e.g. application/json)
  payload: string;         // Base64 ciphertext or IPFS CID
  signature: string;       // Cryptographic signature over canonical hash
}
```

### 3.2 EIP-712 Typed Signing
For EVM and cross-chain clients, messages are signed according to the EIP-712 standard:

* **Domain Separator**:
  * `name`: `"Web3MsgExperiment"`
  * `version`: `"1"`
  * `chainId`: Bound to local or remote chain ID
  * `verifyingContract`: Canonical validator contract address
* **Primary Type**: `Message`
* **Hashing Pipeline**:
  $$\text{hash} = \text{keccak256}(\text{"\x19\x01"} \parallel \text{domainSeparator} \parallel \text{hashStruct}(\text{message}))$$

### 3.3 Payload Encryption
* **Direct Node-to-Node Messaging**:
  * Utilizes Ephemeral Diffie-Hellman / ECIES over secp256k1 or Ed25519/Curve25519 (`X25519`).
  * Shared secret derivation: HKDF-SHA256.
  * Symmetric Cipher: AES-256-GCM with a 96-bit unique IV and 128-bit authentication tag.
* **Broadcast / Group Topics**:
  * Shared epoch keys managed via multi-party ratchet or access-control contracts.

---

## 4. Threat Model & Security Analysis

| Threat Vector | Attack Scenario | Protocol Mitigation |
| :--- | :--- | :--- |
| **Message Tampering** | Adversary alters packet contents in transit. | Payloads are signed with Ed25519 / EIP-712. Any modification invalidates the cryptographic signature, causing immediate drop. |
| **Replay Attacks** | Adversary re-broadcasts previously signed envelopes. | Nodes maintain an active sliding replay cache tracking `(sender, nonce, timestamp)`. Packets outside the valid time drift window ($\pm 60\text{s}$) or with duplicate nonces are rejected. |
| **Sybil & Spam Flooding** | Adversary spins up hundreds of nodes to exhaust bandwidth. | Gossipsub peer scoring ($P_1, P_2, P_3$ parameters) tracks message delivery rates. Invalid messages penalize the peer score; sub-threshold peers are pruned and disconnected. |
| **Eclipse Attacks** | Adversary isolates a target peer by dominating its peer table. | Kademlia DHT enforces diverse bucket allocation across distinct IP subnets and autonomous systems (ASNs). Nodes mandate minimum outbound peer connections. |
| **Traffic Eavesdropping** | Passive network observer snoops message content. | End-to-end encryption (AES-256-GCM / ECIES) ensures third-party relayers and intermediary mesh nodes cannot view plaintext contents. |
| **Identity Impersonation** | Rogue actor claims to speak on behalf of another entity. | Signatures are cryptographically recovered and matched against the sender public key before dispatching to application logic. |

---

## 5. Message Lifecycle & Verification Flow

1. **Construction**: Sender drafts message content and assigns `timestamp` and current `nonce`.
2. **Encryption**: Content is encrypted with recipient's public key (or topic symmetric key) via AES-256-GCM.
3. **Envelope Packaging**: Encrypted ciphertext is formatted into `MessageEnvelope`.
4. **Signature Generation**: Sender signs the canonical serialization of the envelope.
5. **Gossipsub Injection**: The envelope is published to the libp2p topic `web3-msg/v1/direct` or `web3-msg/v1/broadcast`.
6. **Relay Verification**: Intermediary nodes verify:
   * Message size $\le$ maximum transmission limit (64 KB for inline messages; larger payloads must reference an IPFS CID).
   * Timestamp within valid network window.
   * Duplicate message cache does not contain `messageId`.
7. **Delivery & Decryption**: Target recipient validates signature against sender identity, checks nonce monotonicity, decrypts payload with private key, and emits delivery acknowledgment.

---

## 6. Peer Scoring & Mesh Management Parameters

To defend against Denial of Service (DoS) and routing degradation, Gossipsub routers adhere to the following scoring guidelines:

* **$W_{time}$ (Time in Mesh)**: Rewards persistent, stable nodes up to an asymptote.
* **$W_{firstDeliveries}$**: Rewards peers that deliver novel messages first.
* **$W_{meshMessageDeliveries}$**: Penalizes peers that fail to relay messages after advertising them in IHAVE controls.
* **$W_{invalidMessages}$**: Severe penalty ($\le -100$) applied immediately upon receipt of syntactically malformed or invalidly signed messages.

---

## 7. Future Security Enhancements

1. **Double Ratchet Algorithm**: Integration of Signal-style ratchet for forward secrecy and break-in recovery in persistent conversation channels.
2. **Zero-Knowledge Membership Proofs**: ZK-SNARK / Groth16 proofs allowing peers to publish without disclosing wallet addresses on public gossip topics.
3. **Post-Quantum Cryptography (PQC)**: Migration path for hybrid ML-KEM (Kyber) and ML-DSA (Dilithium) key encapsulation and signing.
