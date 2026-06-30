# Section 6: URL Generation Strategy — Hinglish Mein

---

## **Three Approaches Compare Karo**

### **❌ Approach 1: Hash-Based (Bad)**

**How It Works:**

```
User submits: "https://amazon.in/..."

System:
  hash = SHA256("https://amazon.in/...")
       = "a3c2f9d8b1e4...very long..."
  shortCode = take_first_7_chars(hash)
            = "a3c2f9d"
  
Store in database
Return: "bit.ly/a3c2f9d"
```

**Problems:**

```
Problem 1: Deterministic (same URL = same code)
  URL: "https://amazon.in/"
  Code 1: "a3c2f9d"
  Code 2: ... same "a3c2f9d" (collision!)
  
  Why bad? Can't have separate analytics!
  
Problem 2: Collisions (different URLs same code)
  URL 1: "https://amazon.in/"
  URL 2: "https://amazon.com/"  (very similar)
  → Both hash to "a3c2f9d" (rare but possible)
  → Need retry logic: re-hash with suffix
  
Problem 3: Can't hide original URL
  "a3c2f9d" = hash of URL
  → URL fingerprinting
  → Privacy concern
```

**Verdict:** ❌ Avoid for production

---

### **❌ Approach 2: Random String + DB Check (Okay)**

**How It Works:**

```
User submits: "https://amazon.in/"

System:
  shortCode = generate_random_string(7)  // "qwerty1"
  
Check collision:
  SELECT COUNT(*) FROM urls WHERE short_code = 'qwerty1'
  
If collision:
  retry with new random string
Else:
  INSERT
  Return: "bit.ly/qwerty1"
```

**Pros:**

```
✅ Non-deterministic (same URL can have different codes)
✅ Collision handling possible
✅ Each creation independent analytics
```

**Cons:**

```
❌ At scale, collisions increase (birthday paradox)
❌ With 1% of namespace used (35B URLs), collisions frequent
❌ Each collision = another DB lookup (wasted roundtrip)
❌ Not production-grade at Bitly scale
```

**Collision Math:**

```
62^7 = 3.5 trillion combinations

With 1 billion URLs:
  1,000,000,000 / 3,500,000,000,000 = 0.0003%
  
With 100 billion URLs:
  100,000,000,000 / 3,500,000,000,000 = 2.86%
  → Collisions expected!
  
With 500 billion URLs:
  500,000,000,000 / 3,500,000,000,000 = 14.3%
  → 14% of creations collide! 💀
```

**Verdict:** ✅ Works up to ~10B URLs. Then sharding needed.

---

### **✅ Approach 3: Counter + Base62 (PRODUCTION)**

**How It Works:**

```
Users create URLs:
  ID 1 → base62(1)         = "1"
  ID 2 → base62(2)         = "2"
  ID 100 → base62(100)     = "1C"
  ID 1000000 → base62(1000000) = "4c92"
```

**Base62 Explained:**

```
Standard numbers: 0-9 (10 digits)
Base 62: 0-9, a-z, A-Z (62 characters)

Why 62? URL-safe + short strings

Examples:
  ID 1:
    1 % 62 = 1 → 'B' (or '1' depending on alphabet)
    1 / 62 = 0 → stop
    Result: "1"
  
  ID 62:
    62 % 62 = 0 → '0'
    62 / 62 = 1 → continue
    1 % 62 = 1 → '1'
    1 / 62 = 0 → stop
    Result: "10" (reverse: "01") = 1*62 + 0 = 62 ✓
  
  ID 1,000,000:
    Converted step-by-step...
    Result: "4c92"
```

**Algorithm:**

```javascript
function base62Encode(num) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  
  if (num === 0) return '0';
  
  while (num > 0) {
    result = alphabet[num % 62] + result;
    num = Math.floor(num / 62);
  }
  
  return result;
}

function base62Decode(str) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = 0;
  
  for (let char of str) {
    result = result * 62 + alphabet.indexOf(char);
  }
  
  return result;
}

// Tests
console.log(base62Encode(1));       // "1"
console.log(base62Encode(62));      // "10"
console.log(base62Encode(1000000)); // "4c92"
console.log(base62Decode("4c92"));  // 1000000 ✓
```

**Pros:**

```
✅ No collisions (bijective mapping: each ID → unique code)
✅ Deterministic (ID 123 always encodes to "2b")
✅ Predictable namespace (62^7 = 3.5 trillion)
✅ Storage efficient (7 chars for 62^7 combinations)
✅ Fast encoding (single while loop)
✅ Reversible (decode to get original ID)
```

**Cons:**

```
❌ Sequential appearance (ID 1, 2, 3... → '1', '2', '3'...)
   Leaks business metrics! ("We created 1 billion URLs!")
   
❌ Enumeration attack (attacker cycles through all codes)
```

**Solution: Shuffle It!**

```
Problem: Sequential codes leak information

Solution: Use shuffled permutation

Example Shuffled Alphabet:
  Normal: 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
  Shuffled: z8xK5bPm9Q2hL7jR1w4sYt3vU6nF0aGeCoD (random order)

Encoding:
  ID 1 → base62(1) with shuffled alphabet
        → '8' (instead of '1')
  
  ID 2 → base62(2) with shuffled alphabet
        → 'x' (instead of '2')
  
Result: "8", "x", "K", ... (looks random!)
Actually: Still bijective + deterministic
          Decoding works: "8" → base62_decode → ID 1
```

**Shuffled Implementation:**

```javascript
const shuffledAlphabet = 'z8xK5bPm9Q2hL7jR1w4sYt3vU6nF0aGeCoD';

function base62EncodeShuffled(num) {
  let result = '';
  
  if (num === 0) return shuffledAlphabet[0];
  
  while (num > 0) {
    result = shuffledAlphabet[num % 62] + result;
    num = Math.floor(num / 62);
  }
  
  return result;
}

// Test
console.log(base62EncodeShuffled(1));   // "8"
console.log(base62EncodeShuffled(2));   // "x"
console.log(base62EncodeShuffled(100)); // Something random-looking
```

**Why Shuffle Works:**

```
✅ Prevents enumeration
  Attacker doesn't know: "abc123" = ID 123
  
✅ Still reversible
  Store both: (ID, shortened_code) in database
  
✅ Business metrics hidden
  Outside world doesn't know total URL count
  
✅ No performance cost
  Just array lookup (shuffled alphabet)
```

---

## **Distributed ID Generation (At Scale)**

### **Problem with Single Counter:**

```
Scenario: Multiple regions (US, EU, IN)

Single ID generator:
  US creates: ID 1, 2, 3, 4, 5
  EU creates: ID 6, 7, 8, 9, 10
  → Single point of failure
  → Network latency for every creation
  → Bottleneck: only one place issuing IDs
```

### **Solution: Twitter Snowflake Algorithm**

**Concept:**

```
Each ID = 64-bit number with embedded info

┌─────────────────────────────────────────────┐
│ 1 │ 41-bit timestamp │ 10-bit data │ 12-bit │
│ bit│  (milliseconds)   │center ID │sequence│
│(unused)│  (like Unix time)│  (0-1023) │number │
└─────────────────────────────────────────────┘

Example:
  Timestamp: 1713268200000 (current time)
  Datacenter: 001 (EU region)
  Sequence: 001 (3rd creation in this millisecond)
  
  → Combined: unique 64-bit ID
```

**Advantages:**

```
✅ No central ID server needed
✅ Each datacenter issues IDs independently
✅ IDs are roughly time-ordered
✅ 12-bit sequence handles 4096 IDs/millisecond
✅ Theoretically: 1000 years of unique IDs

But for our scale:
  115K creates/sec / 1000ms = 115 IDs/ms
  12-bit sequence = 4096 IDs/ms
  → Plenty of capacity!
```

**Implementation:**

```javascript
class SnowflakeIdGenerator {
  constructor(datacenterId) {
    this.datacenterId = datacenterId;  // 0-31 (5 bits)
    this.workerId = 0;                 // 0-31 (5 bits)
    this.sequence = 0;
    this.lastTimestamp = -1;
  }
  
  generate() {
    let timestamp = Date.now();
    
    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1) & 4095;  // 12-bit wrap
      if (this.sequence === 0) {
        // Sequence overflow, wait for next millisecond
        timestamp = this.waitNextMillis();
      }
    } else {
      this.sequence = 0;
    }
    
    this.lastTimestamp = timestamp;
    
    // Combine into 64-bit ID
    return (
      ((timestamp - EPOCH) << 22) |  // Timestamp (41 bits)
      (this.datacenterId << 17) |     // Datacenter (5 bits)
      (this.workerId << 12) |         // Worker (5 bits)
      this.sequence                   // Sequence (12 bits)
    );
  }
  
  waitNextMillis() {
    let timestamp = Date.now();
    while (timestamp <= this.lastTimestamp) {
      timestamp = Date.now();
    }
    return timestamp;
  }
}

// Usage
const generator = new SnowflakeIdGenerator(1);  // EU datacenter
const id1 = generator.generate();  // 123456789012345
const id2 = generator.generate();  // 123456789012346
```

---

## **Custom Alias Handling**

### **Problem:**

```
User wants: "bit.ly/sale2024" (custom, memorable)
Not: "bit.ly/4c92"

But system generates codes via counter!
```

### **Solution:**

```
Check if custom alias already taken:
  SELECT COUNT(*) FROM urls WHERE short_code = 'sale2024'
  
If available:
  INSERT with short_code = 'sale2024'
  (NOT generated via base62)
  
If taken:
  Return 409 Conflict
  Suggest: "sale2024_001", "sale2024_002"...
```

**Database Schema:**

```sql
CREATE TABLE urls (
  id BIGSERIAL,
  short_code VARCHAR(12) NOT NULL UNIQUE,  ← Both generated + custom!
  original_url TEXT,
  custom_alias VARCHAR(50),  ← User requested string
  ...
);

-- Examples:
-- ID 123, auto-generated: short_code = "4c92"
-- ID 124, custom: short_code = "sale2024", custom_alias = "sale2024"
-- ID 125, auto-generated: short_code = "4c93"
```

**Logic:**

```javascript
async function createUrl(originalUrl, customAlias) {
  let shortCode;
  
  if (customAlias) {
    // Check if available
    const existing = await db.query(
      'SELECT id FROM urls WHERE short_code = ?',
      [customAlias]
    );
    
    if (existing) {
      throw new Error('Alias already taken');
    }
    
    shortCode = customAlias;
  } else {
    // Generate via counter
    const result = await db.query(
      'INSERT INTO urls (original_url) VALUES (?) RETURNING id',
      [originalUrl]
    );
    
    shortCode = base62Encode(result.rows[0].id);
  }
  
  // Update or re-insert with short_code
  await db.query(
    'UPDATE urls SET short_code = ? WHERE ...',
    [shortCode]
  );
  
  return shortCode;
}
```

---

## **Collision Handling Summary**

| Approach | Collisions | Enumeration | Verdict |
|---|---|---|---|
| Hash | Possible | High (can fingerprint) | ❌ Bad |
| Random | Frequent at scale | None | ✅ Okay (up to 10B) |
| Counter + Base62 | Zero | High (sequential) | ✅ Good |
| Counter + Shuffled | Zero | None | ✅ Best |
| Custom Alias | Manual check | N/A | ✅ Good |
| Snowflake | Zero | High (time-ordered) | ✅ Distributed |

---

## **Interview Question: "Why Base62?"**

### **Concise Answer:**

```
"Base62 uses 0-9 + a-z + A-Z.
With 7 characters: 62^7 = 3.5 trillion combinations.
Enough for billions of URLs.

Why not Base64?
  - Contains / and +, not URL-safe
  
Why not UUID?
  - UUIDs are 128-bit → 22-char Base62 string
  - Too long for a shortener!
  
Why not MD5/SHA?
  - Produces fixed 32-char hex string
  - Can't shorten further (deterministic collision on same URL)
  
Base62 is the sweet spot:
  - Short (7-12 chars)
  - URL-safe
  - Bijective (no collisions)
  - Fast encoding/decoding
"
```

---

## **Section 6 Takeaway**

✅ **Three Approaches:**
- Hash: Bad (collisions + deterministic)
- Random: Okay (works up to scale limits)
- Counter + Base62: Production (no collisions + efficient)

✅ **Base62 Algorithm:**
- Implementation: while loop with modulo division
- Encoding: 7 chars for 62^7 combinations
- Decoding: reverse process

✅ **Enumeration Protection:**
- Shuffle alphabet to hide sequential nature
- Still deterministic for decoding
- Prevents business metric leakage

✅ **Scaling:**
- Snowflake IDs for multi-datacenter
- Distributed ID generation
- No single point of failure

✅ **Custom Aliases:**
- Check uniqueness before assignment
- Same column as auto-generated codes
- 409 on conflict

---

**Next:** Section 7 — Day-by-Day Execution Plan (14 days)
