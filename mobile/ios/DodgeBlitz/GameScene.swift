import SpriteKit

/// A simple endless dodge game: drag to steer the player, avoid falling
/// obstacles, and survive as long as possible. Difficulty ramps up over time.
final class GameScene: SKScene, SKPhysicsContactDelegate {

    private let playerCategory: UInt32 = 0x1 << 0
    private let obstacleCategory: UInt32 = 0x1 << 1

    private var player: SKShapeNode!
    private var scoreLabel: SKLabelNode!
    private var bestLabel: SKLabelNode!
    private var statusLabel: SKLabelNode!

    private var score: Double = 0
    private var highScore: Int = UserDefaults.standard.integer(forKey: "dodgeBlitzHighScore")
    private var elapsed: Double = 0
    private var spawnTimer: Double = 0
    private var spawnInterval: Double = 1.1
    private var isGameOver = false
    private var lastUpdateTime: TimeInterval = 0

    override func didMove(to view: SKView) {
        backgroundColor = SKColor(red: 0.06, green: 0.06, blue: 0.09, alpha: 1)
        physicsWorld.gravity = .zero
        physicsWorld.contactDelegate = self

        setupPlayer()
        setupLabels()
        resetGame()
    }

    private func setupPlayer() {
        player = SKShapeNode(circleOfRadius: 22)
        player.fillColor = SKColor(red: 0, green: 0.9, blue: 0.63, alpha: 1)
        player.strokeColor = .clear
        player.position = CGPoint(x: size.width / 2, y: size.height * 0.15)

        let body = SKPhysicsBody(circleOfRadius: 22)
        body.isDynamic = false
        body.categoryBitMask = playerCategory
        body.contactTestBitMask = obstacleCategory
        body.collisionBitMask = 0
        player.physicsBody = body

        addChild(player)
    }

    private func setupLabels() {
        scoreLabel = SKLabelNode(fontNamed: "Menlo-Bold")
        scoreLabel.fontSize = 24
        scoreLabel.horizontalAlignmentMode = .left
        scoreLabel.position = CGPoint(x: 20, y: size.height - 50)
        addChild(scoreLabel)

        bestLabel = SKLabelNode(fontNamed: "Menlo-Bold")
        bestLabel.fontSize = 24
        bestLabel.horizontalAlignmentMode = .left
        bestLabel.position = CGPoint(x: 20, y: size.height - 80)
        addChild(bestLabel)

        statusLabel = SKLabelNode(fontNamed: "Menlo-Bold")
        statusLabel.fontSize = 28
        statusLabel.position = CGPoint(x: size.width / 2, y: size.height / 2)
        statusLabel.isHidden = true
        addChild(statusLabel)
    }

    private func resetGame() {
        removeObstacles()
        score = 0
        elapsed = 0
        spawnTimer = 0
        spawnInterval = 1.1
        isGameOver = false
        statusLabel.isHidden = true
        player.position = CGPoint(x: size.width / 2, y: size.height * 0.15)
        updateLabels()
    }

    private func removeObstacles() {
        enumerateChildNodes(withName: "obstacle") { node, _ in
            node.removeFromParent()
        }
    }

    private func updateLabels() {
        scoreLabel.text = "Score: \(Int(score))"
        bestLabel.text = "Best: \(highScore)"
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        if isGameOver {
            resetGame()
            return
        }
        moveTowards(touches: touches)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard !isGameOver else { return }
        moveTowards(touches: touches)
    }

    private func moveTowards(touches: Set<UITouch>) {
        guard let touch = touches.first else { return }
        let location = touch.location(in: self)
        let clampedX = min(max(location.x, 24), size.width - 24)
        player.position.x = clampedX
    }

    override func update(_ currentTime: TimeInterval) {
        if lastUpdateTime == 0 { lastUpdateTime = currentTime }
        let dt = min(currentTime - lastUpdateTime, 0.05)
        lastUpdateTime = currentTime

        guard !isGameOver else { return }

        elapsed += dt
        score += dt * 10
        spawnInterval = max(0.45, 1.1 - elapsed * 0.01)
        spawnTimer += dt

        if spawnTimer >= spawnInterval {
            spawnTimer = 0
            spawnObstacle()
        }

        updateLabels()
    }

    private func spawnObstacle() {
        let radius = CGFloat.random(in: 14...34)
        let x = CGFloat.random(in: radius...(size.width - radius))
        let obstacle = SKShapeNode(circleOfRadius: radius)
        obstacle.name = "obstacle"
        obstacle.fillColor = SKColor(red: 1, green: 0.3, blue: 0.3, alpha: 1)
        obstacle.strokeColor = .clear
        obstacle.position = CGPoint(x: x, y: size.height + radius)

        let body = SKPhysicsBody(circleOfRadius: radius)
        body.categoryBitMask = obstacleCategory
        body.contactTestBitMask = playerCategory
        body.collisionBitMask = 0
        body.affectedByGravity = false
        obstacle.physicsBody = body

        addChild(obstacle)

        let speed = 220 + elapsed * 8
        let duration = TimeInterval((size.height + radius * 2) / CGFloat(speed))
        let fall = SKAction.moveTo(y: -radius, duration: duration)
        let remove = SKAction.removeFromParent()
        obstacle.run(.sequence([fall, remove]))
    }

    func didBegin(_ contact: SKPhysicsContact) {
        guard !isGameOver else { return }
        triggerGameOver()
    }

    private func triggerGameOver() {
        isGameOver = true
        let finalScore = Int(score)
        if finalScore > highScore {
            highScore = finalScore
            UserDefaults.standard.set(highScore, forKey: "dodgeBlitzHighScore")
        }
        updateLabels()
        statusLabel.text = "Game Over — Tap to Restart"
        statusLabel.isHidden = false
    }
}
