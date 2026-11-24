import XCTest
@testable import AgentCapPolicy

final class WalletNetworkPolicyTests: XCTestCase {
    func testWalletTransportCannotSendCredentialsOrWritesToPublicRPC() {
        XCTAssertNotNil(WalletNetworkPolicy.destination("https://rpc.mainnet.chain.robinhood.com", method: "POST", operation: "create", rpcMethod: "eth_call"))
        for address in ["https://app.agentcap.xyz.evil.test/api/grants", "http://app.agentcap.xyz/api/grants", "https://x@app.agentcap.xyz/api/grants", "//evil.test/api/grants", "https://app.agentcap.xyz:8443/api/grants"] {
            XCTAssertNil(WalletNetworkPolicy.destination(address, method: "POST", operation: "create", rpcMethod: nil))
        }
        XCTAssertNil(WalletNetworkPolicy.destination("https://rpc.mainnet.chain.robinhood.com", method: "POST", operation: "withdraw", rpcMethod: "eth_sendRawTransaction"))
        XCTAssertNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "POST", operation: "reconcile", rpcMethod: "eth_sendUserOperation"))
        XCTAssertNil(WalletNetworkPolicy.destination("/api/grants", method: "POST", operation: "plan", rpcMethod: nil))
        XCTAssertNotNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "POST", operation: "withdraw", rpcMethod: "eth_sendUserOperation"))
    }
}
