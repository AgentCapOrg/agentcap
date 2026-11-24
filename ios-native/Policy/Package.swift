// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgentCapPolicy",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "AgentCapPolicy", targets: ["AgentCapPolicy"])],
    targets: [
        .target(name: "AgentCapPolicy"),
        .testTarget(name: "AgentCapPolicyTests", dependencies: ["AgentCapPolicy"])
    ]
)

