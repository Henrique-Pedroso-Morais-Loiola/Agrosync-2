const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
// Em hospedagem com volume persistente, configure DATA_DIR=/data.
const DATA_DIR = process.env.DATA_DIR || __dirname;
require("fs").mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "agrosync.db"));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Cria as tabelas automaticamente na primeira execução.
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price REAL NOT NULL,
    oldPrice REAL NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL,
    image TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total REAL NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orderId INTEGER NOT NULL,
    productId INTEGER NOT NULL,
    productName TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unitPrice REAL NOT NULL,
    FOREIGN KEY (orderId) REFERENCES orders(id),
    FOREIGN KEY (productId) REFERENCES products(id)
  );
`);

const productCount = db.prepare("SELECT COUNT(*) AS total FROM products").get().total;
if (productCount === 0) {
  const insert = db.prepare(`
    INSERT INTO products (name, description, price, oldPrice, quantity, category, image)
    VALUES (@name, @description, @price, @oldPrice, @quantity, @category, @image)
  `);

  const initialProducts = [
    { name: "Morangos Orgânicos Premium", description: "Caixa de 5kg • Sítio Bela Vista", price: 45.90, oldPrice: 90.00, quantity: 4, category: "Frutas", image: "https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=500&q=80" },
    { name: "Cesta de Folhosas Variadas", description: "Alface, rúcula e espinafre • 3kg", price: 22.00, oldPrice: 32.00, quantity: 4, category: "Verduras", image: "https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=500&q=80" },
    { name: "Tomate Italiano", description: "Caixa de 4kg • Produção local", price: 18.50, oldPrice: 27.00, quantity: 4, category: "Legumes", image: "https://images.unsplash.com/photo-1546094096-0df4bcaaa337?auto=format&fit=crop&w=500&q=80" },
    { name: "Banana Nanica", description: "Penca selecionada de 5kg", price: 16.90, oldPrice: 24.00, quantity: 4, category: "Frutas", image: "https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?auto=format&fit=crop&w=500&q=80" },
    { name: "Cenoura Fresca", description: "Saco de 3kg • Colheita da semana", price: 12.90, oldPrice: 19.00, quantity: 4, category: "Legumes", image: "https://images.unsplash.com/photo-1445282768818-728615cc910a?auto=format&fit=crop&w=500&q=80" },
    { name: "Laranja Pera", description: "Saco de 5kg • Direto do produtor", price: 19.90, oldPrice: 29.00, quantity: 4, category: "Frutas", image: "https://images.unsplash.com/photo-1547514701-42782101795e?auto=format&fit=crop&w=500&q=80" }
  ];
  const seed = db.transaction((items) => items.forEach(item => insert.run(item)));
  seed(initialProducts);
}

// Atualização única do estoque para 4 unidades por produto.
 // A tabela de controle evita repor estoque em cada reinicialização do servidor.
db.exec(`CREATE TABLE IF NOT EXISTS app_migrations (
  name TEXT PRIMARY KEY
)`);
const migrationName = "estoque_inicial_4_unidades_v1";
const applied = db.prepare("SELECT 1 FROM app_migrations WHERE name = ?").get(migrationName);
if (!applied) {
  db.transaction(() => {
    db.prepare("UPDATE products SET quantity = 4").run();
    db.prepare("INSERT INTO app_migrations (name) VALUES (?)").run(migrationName);
  })();
}


function requireAdmin(req, res, next) {
  const configured = process.env.ADMIN_KEY;
  if (!configured || req.get("x-admin-key") !== configured) {
    return res.status(403).json({ error: "Acesso administrativo não autorizado." });
  }
  next();
}

// Lista produtos e seus saldos atuais.
app.get("/api/products", (req, res) => {
  const products = db.prepare("SELECT * FROM products ORDER BY id").all();
  res.json(products);
});

// Cadastro simples de produto (útil para demonstração).
app.post("/api/products", requireAdmin, (req, res) => {
  const { name, description, price, oldPrice, quantity, category, image } = req.body;
  if (!name || !description || !category || !image ||
      !Number.isFinite(Number(price)) || !Number.isInteger(Number(quantity)) ||
      Number(quantity) < 0) {
    return res.status(400).json({ error: "Informe nome, descrição, preços, quantidade válida, categoria e imagem." });
  }
  const result = db.prepare(`
    INSERT INTO products (name, description, price, oldPrice, quantity, category, image)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, description, Number(price), Number(oldPrice || price), Number(quantity), category, image);
  res.status(201).json(db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid));
});

// Atualiza a quantidade disponível de um produto.
app.patch("/api/products/:id/quantity", requireAdmin, (req, res) => {
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) {
    return res.status(400).json({ error: "A quantidade deve ser um número inteiro igual ou maior que zero." });
  }
  const result = db.prepare("UPDATE products SET quantity = ? WHERE id = ?").run(quantity, req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id));
});

// Registra o pedido e baixa o estoque em uma única transação.
app.post("/api/orders", (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "O pedido precisa conter ao menos um produto." });
  }

  try {
    const createOrder = db.transaction(() => {
      let total = 0;
      const details = [];

      for (const item of items) {
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          throw new Error("Quantidade inválida no pedido.");
        }
        const product = db.prepare("SELECT * FROM products WHERE id = ?").get(item.productId);
        if (!product) throw new Error("Um dos produtos não foi encontrado.");
        if (product.quantity < quantity) {
          throw new Error(`Estoque insuficiente para ${product.name}. Disponível: ${product.quantity}.`);
        }
        total += product.price * quantity;
        details.push({ product, quantity });
      }

      const order = db.prepare("INSERT INTO orders (total) VALUES (?)").run(total);
      const updateStock = db.prepare("UPDATE products SET quantity = quantity - ? WHERE id = ?");
      const insertItem = db.prepare(`
        INSERT INTO order_items (orderId, productId, productName, quantity, unitPrice)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const detail of details) {
        updateStock.run(detail.quantity, detail.product.id);
        insertItem.run(order.lastInsertRowid, detail.product.id, detail.product.name,
          detail.quantity, detail.product.price);
      }
      return { orderId: Number(order.lastInsertRowid), total };
    });

    res.status(201).json(createOrder());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Consulta pedidos registrados, para facilitar a demonstração.
app.get("/api/orders", requireAdmin, (req, res) => {
  const orders = db.prepare("SELECT * FROM orders ORDER BY id DESC").all();
  const items = db.prepare("SELECT * FROM order_items ORDER BY id").all();
  res.json(orders.map(order => ({ ...order, items: items.filter(item => item.orderId === order.id) })));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AgroSync online na porta ${PORT}`);
  console.log(`Banco SQLite em ${path.join(DATA_DIR, "agrosync.db")}`);
});
