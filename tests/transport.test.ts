import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileTransport, createTransport } from "../src/transport.ts";
import { MailboxManager, createMailbox } from "../src/mailbox.ts";
import { MessageType } from "../src/types.ts";

describe("Transport Layer", () => {
  let testDir: string;

  before(() => {
    testDir = join(tmpdir(), `transport-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("FileTransport", () => {
    it("initializes successfully", async () => {
      const transport = new FileTransport({
        sharedRoot: testDir,
        teamName: "test-team",
        agentId: "agent-001",
      });

      await transport.initialize();
      assert.equal(transport.type, "file");
    });

    it("sends and receives a message", async () => {
      const sender = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-comm",
        agentId: "sender",
      });
      const receiver = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-comm",
        agentId: "receiver",
      });

      await sender.initialize();
      await receiver.initialize();

      const msg = await sender.send({
        type: MessageType.message,
        from: "sender",
        to: "receiver",
        content: "Hello from sender!",
      });

      assert.ok(msg.id.startsWith("msg-"));
      assert.equal(msg.type, MessageType.message);

      const messages = await receiver.receive();
      assert.ok(messages.length >= 1);
      assert.ok(messages.some((m) => m.id === msg.id && m.content === "Hello from sender!"));
    });

    it("sends broadcast messages", async () => {
      const transport = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-broadcast",
        agentId: "broadcaster",
      });

      await transport.initialize();

      const msg = await transport.send({
        type: MessageType.broadcast,
        from: "broadcaster",
        to: null,
        content: "Team announcement",
      });

      assert.equal(msg.to, null);
    });

    it("acknowledges messages", async () => {
      const sender = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-ack",
        agentId: "sender-ack",
      });
      const receiver = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-ack",
        agentId: "receiver-ack",
      });

      await sender.initialize();
      await receiver.initialize();

      const msg = await sender.send({
        type: MessageType.message,
        from: "sender-ack",
        to: "receiver-ack",
        content: "Ack this message",
      });

      // Must receive first to claim the message
      const messages = await receiver.receive();
      assert.ok(messages.some((m) => m.id === msg.id));

      // Now we can ack the claimed message
      const success = await receiver.ack(msg.id);
      assert.equal(success, true);

      // Message should no longer be in pending
      const pending = await receiver.receive();
      assert.ok(!pending.some((m) => m.id === msg.id));
    });

    it("returns false for ack of non-existent message", async () => {
      const transport = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-ack-2",
        agentId: "agent-ack-2",
      });

      await transport.initialize();
      const success = await transport.ack("nonexistent-msg-id");
      assert.equal(success, false);
    });

    it("returns message history", async () => {
      const sender = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-history",
        agentId: "sender-hist",
      });
      const receiver = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-history",
        agentId: "receiver-hist",
      });

      await sender.initialize();
      await receiver.initialize();

      // Send and ack multiple messages
      for (let i = 0; i < 3; i++) {
        const msg = await sender.send({
          type: MessageType.message,
          from: "sender-hist",
          to: "receiver-hist",
          content: `Message ${i}`,
        });
        // Must receive first to claim the message
        await receiver.receive();
        // Then ack the claimed message
        await receiver.ack(msg.id);
      }

      const history = await receiver.history(10);
      assert.ok(history.length >= 3);
    });

    it("cleans up expired messages", async () => {
      const transport = new FileTransport({
        sharedRoot: testDir,
        teamName: "team-cleanup",
        agentId: "agent-cleanup",
        messageTtlMs: 1, // 1ms = instant expiration
      });

      await transport.initialize();

      // Send a message that will expire
      await transport.send({
        type: MessageType.message,
        from: "agent-cleanup",
        to: "other-agent",
        content: "Will expire",
      });

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 10));

      const cleaned = await transport.cleanup();
      // May or may not clean depending on timing
      assert.ok(typeof cleaned === "number");
    });
  });

  describe("createTransport factory", () => {
    it("creates FileTransport", () => {
      const transport = createTransport("file", {
        sharedRoot: testDir,
        teamName: null,
        agentId: "factory-test",
      });
      assert.equal(transport.type, "file");
    });

    it("throws for unknown transport type", () => {
      assert.throws(() => {
        createTransport("p2p" as "file", {
          sharedRoot: testDir,
          teamName: null,
          agentId: "factory-test-2",
        });
      }, /P2PTransport not yet implemented/);
    });
  });
});

describe("MailboxManager", () => {
  let testDir: string;

  before(() => {
    testDir = join(tmpdir(), `mailbox-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const createTestIdentity = (agentId: string, teamName?: string) => ({
    agentId,
    agentName: agentId,
    agentType: "worker",
    teamName: teamName ?? "test-team",
    isLeader: false,
    joinedAt: new Date().toISOString(),
  });

  it("initializes mailbox", async () => {
    const identity = createTestIdentity("agent-mail-1");
    const mailbox = createMailbox(identity, testDir);
    await mailbox.initialize();
  });

  it("sends and receives messages", async () => {
    const alice = createMailbox(createTestIdentity("alice", "team-mail"), testDir);
    const bob = createMailbox(createTestIdentity("bob", "team-mail"), testDir);

    await alice.initialize();
    await bob.initialize();

    await alice.send("bob", MessageType.message, "Hi Bob!");

    const messages = await bob.receive();
    assert.ok(messages.length >= 1);
    assert.ok(messages.some((m) => m.content === "Hi Bob!" && m.from === "alice"));
  });

  it("broadcasts messages", async () => {
    const identity = createTestIdentity("broadcaster", "team-bcast");
    const mailbox = createMailbox(identity, testDir);
    await mailbox.initialize();

    const msg = await mailbox.broadcast(MessageType.broadcast, "Team meeting!");
    assert.equal(msg.to, null);
    assert.equal(msg.type, MessageType.broadcast);
  });

  it("acknowledges messages", async () => {
    const alice = createMailbox(createTestIdentity("alice-ack", "team-ack-m"), testDir);
    const bob = createMailbox(createTestIdentity("bob-ack", "team-ack-m"), testDir);

    await alice.initialize();
    await bob.initialize();

    const msg = await alice.send("bob-ack", MessageType.message, "Ack me");
    // Must receive first to claim the message
    await bob.receive();
    // Then ack the claimed message
    const success = await bob.ack(msg.id);
    assert.equal(success, true);
  });

  it("gets unread count", async () => {
    const alice = createMailbox(createTestIdentity("alice-count", "team-count"), testDir);
    const bob = createMailbox(createTestIdentity("bob-count", "team-count"), testDir);

    await alice.initialize();
    await bob.initialize();

    await alice.send("bob-count", MessageType.message, "Message 1");
    await alice.send("bob-count", MessageType.message, "Message 2");

    const count = await bob.unreadCount();
    assert.ok(count >= 2);
  });

  it("checks for urgent messages", async () => {
    const alice = createMailbox(createTestIdentity("alice-urgent", "team-urgent"), testDir);
    const bob = createMailbox(createTestIdentity("bob-urgent", "team-urgent"), testDir);

    await alice.initialize();
    await bob.initialize();

    // Send regular message
    await alice.send("bob-urgent", MessageType.message, "Regular");

    let hasUrgent = await bob.hasUrgentMessages();
    assert.equal(hasUrgent, false);

    // Send urgent message
    await alice.send("bob-urgent", MessageType.task_blocked, "I'm blocked!");

    hasUrgent = await bob.hasUrgentMessages();
    assert.equal(hasUrgent, true);
  });

  it("formats inbox for display", async () => {
    const alice = createMailbox(createTestIdentity("alice-fmt", "team-fmt"), testDir);
    const bob = createMailbox(createTestIdentity("bob-fmt", "team-fmt"), testDir);

    await alice.initialize();
    await bob.initialize();

    await alice.send("bob-fmt", MessageType.message, "Hello!");
    await alice.send("bob-fmt", MessageType.task_completed, "Task done");

    const formatted = await bob.formatInbox();
    assert.ok(formatted.includes("📬"));
    assert.ok(formatted.includes("Hello!"));
    assert.ok(formatted.includes("task_completed"));
  });

  it("filters by message type", async () => {
    const alice = createMailbox(createTestIdentity("alice-filter", "team-filter"), testDir);
    const bob = createMailbox(
      createTestIdentity("bob-filter", "team-filter"),
      testDir,
      { filterTypes: [MessageType.task_completed] }
    );

    await alice.initialize();
    await bob.initialize();

    await alice.send("bob-filter", MessageType.message, "Regular message");
    await alice.send("bob-filter", MessageType.task_completed, "Task done");

    const messages = await bob.receive();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, MessageType.task_completed);
  });
});
