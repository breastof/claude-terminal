const db = require("./db");

class ChatManager {
  constructor(presenceManager) {
    this.presenceManager = presenceManager;
  }

  /**
   * Save message + attachments to DB, broadcast to all connected peers.
   * @param {number} userId
   * @param {string} text
   * @param {Array<{filePath: string, originalName: string, mimeType: string, size: number}>} attachments
   * @returns {object} Full message with user info and attachments
   */
  sendMessage(userId, text, attachments = [], replyToId = null) {
    const insertMsg = db.prepare(
      "INSERT INTO messages (user_id, text, reply_to_id) VALUES (?, ?, ?)"
    );
    const insertAttachment = db.prepare(
      `INSERT INTO attachments (message_id, file_path, original_name, mime_type, size)
       VALUES (?, ?, ?, ?, ?)`
    );

    const result = insertMsg.run(userId, text || "", replyToId || null);
    const messageId = result.lastInsertRowid;

    for (const att of attachments) {
      insertAttachment.run(
        messageId,
        att.filePath,
        att.originalName,
        att.mimeType,
        att.size
      );
    }

    // Fetch full message with JOIN
    const message = this._getMessageById(messageId);

    // Broadcast to all connected presence peers (global chat)
    this.broadcast({ type: "chat_message", message });

    return message;
  }

  /**
   * Get paginated messages (newest first, reversed to chronological for client).
   * @param {number|null} before - Message ID to load older than
   * @param {number} limit
   * @returns {Array} Messages with user info and attachments
   */
  getMessages(before = null, limit = 50) {
    let rows;
    if (before) {
      rows = db
        .prepare(
          `SELECT m.id, m.user_id, m.text, m.created_at, m.reply_to_id,
                  u.login, u.first_name, u.last_name, u.role, u.color_index,
                  rm.id AS rt_id, rm.text AS rt_text,
                  ru.first_name AS rt_first_name, ru.last_name AS rt_last_name, ru.color_index AS rt_color_index
           FROM messages m
           JOIN users u ON m.user_id = u.id
           LEFT JOIN messages rm ON m.reply_to_id = rm.id
           LEFT JOIN users ru ON rm.user_id = ru.id
           WHERE m.id < ?
           ORDER BY m.id DESC
           LIMIT ?`
        )
        .all(before, limit);
    } else {
      rows = db
        .prepare(
          `SELECT m.id, m.user_id, m.text, m.created_at, m.reply_to_id,
                  u.login, u.first_name, u.last_name, u.role, u.color_index,
                  rm.id AS rt_id, rm.text AS rt_text,
                  ru.first_name AS rt_first_name, ru.last_name AS rt_last_name, ru.color_index AS rt_color_index
           FROM messages m
           JOIN users u ON m.user_id = u.id
           LEFT JOIN messages rm ON m.reply_to_id = rm.id
           LEFT JOIN users ru ON rm.user_id = ru.id
           ORDER BY m.id DESC
           LIMIT ?`
        )
        .all(limit);
    }

    // Reverse to chronological order
    rows.reverse();

    // Fetch attachments for all messages in batch
    const messageIds = rows.map((r) => r.id);
    const attachments = this._getAttachmentsForMessages(messageIds);

    return rows.map((row) => this._mapRow(row, attachments));
  }

  /**
   * Get media attachments for gallery.
   * @param {string|null} type - "images" or "files"
   * @param {number} offset
   * @param {number} limit
   * @returns {Array} Attachments with user info
   */
  getMedia(type = null, offset = 0, limit = 50) {
    let whereClause = "";
    if (type === "images") {
      whereClause = "AND a.mime_type LIKE 'image/%'";
    } else if (type === "files") {
      whereClause = "AND a.mime_type NOT LIKE 'image/%'";
    }

    return db
      .prepare(
        `SELECT a.id, a.file_path, a.original_name, a.mime_type, a.size, a.created_at,
                u.id as user_id, u.login, u.first_name, u.last_name, u.color_index
         FROM attachments a
         JOIN messages m ON a.message_id = m.id
         JOIN users u ON m.user_id = u.id
         ${whereClause}
         ORDER BY a.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset)
      .map((row) => ({
        id: row.id,
        filePath: row.file_path,
        originalName: row.original_name,
        mimeType: row.mime_type,
        size: row.size,
        createdAt: row.created_at,
        user: {
          id: row.user_id,
          login: row.login,
          firstName: row.first_name,
          lastName: row.last_name,
          colorIndex: row.color_index,
        },
      }));
  }

  /**
   * Broadcast a message to ALL connected presence peers (global chat).
   */
  broadcast(message) {
    const msg = JSON.stringify(message);
    for (const [, peer] of this.presenceManager.peers) {
      if (peer.ws.readyState === 1) {
        peer.ws.send(msg);
      }
    }
  }

  _getMessageById(id) {
    const row = db
      .prepare(
        `SELECT m.id, m.user_id, m.text, m.created_at, m.reply_to_id,
                u.login, u.first_name, u.last_name, u.role, u.color_index,
                rm.id AS rt_id, rm.text AS rt_text,
                ru.first_name AS rt_first_name, ru.last_name AS rt_last_name, ru.color_index AS rt_color_index
         FROM messages m
         JOIN users u ON m.user_id = u.id
         LEFT JOIN messages rm ON m.reply_to_id = rm.id
         LEFT JOIN users ru ON rm.user_id = ru.id
         WHERE m.id = ?`
      )
      .get(id);

    if (!row) return null;

    const attachments = db
      .prepare(
        `SELECT id, file_path, original_name, mime_type, size, created_at
         FROM attachments WHERE message_id = ?`
      )
      .all(id)
      .map((a) => ({
        id: a.id,
        filePath: a.file_path,
        originalName: a.original_name,
        mimeType: a.mime_type,
        size: a.size,
        createdAt: a.created_at,
      }));

    const grouped = { [id]: attachments };
    return this._mapRow(row, grouped);
  }

  _mapRow(row, attachmentsMap) {
    return {
      id: row.id,
      text: row.text,
      createdAt: row.created_at,
      replyTo: row.rt_id
        ? {
            id: row.rt_id,
            text: (row.rt_text || "").slice(0, 100),
            user: {
              firstName: row.rt_first_name,
              lastName: row.rt_last_name,
              colorIndex: row.rt_color_index,
            },
          }
        : null,
      user: {
        id: row.user_id,
        login: row.login,
        firstName: row.first_name,
        lastName: row.last_name,
        role: row.role,
        colorIndex: row.color_index,
      },
      attachments: attachmentsMap[row.id] || [],
    };
  }

  _getAttachmentsForMessages(messageIds) {
    if (messageIds.length === 0) return {};

    const placeholders = messageIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, message_id, file_path, original_name, mime_type, size, created_at
         FROM attachments WHERE message_id IN (${placeholders})`
      )
      .all(...messageIds);

    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.message_id]) grouped[row.message_id] = [];
      grouped[row.message_id].push({
        id: row.id,
        filePath: row.file_path,
        originalName: row.original_name,
        mimeType: row.mime_type,
        size: row.size,
        createdAt: row.created_at,
      });
    }
    return grouped;
  }
}

module.exports = { ChatManager };
