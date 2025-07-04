// index.js
import { onRequest } from "firebase-functions/v2/https";
import admin from "firebase-admin";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import functions from "firebase-functions";

const config = functions.config().adminsdk;

// const serviceAccount = {
//   type: config.type,
//   project_id: config.project_id,
//   private_key_id: config.private_key_id,
//   private_key: config.private_key.replace(/\\n/g, "\n"),
//   client_email: config.client_email,
//   client_id: config.client_id,
//   auth_uri: config.auth_uri,
//   token_uri: config.token_uri,
//   auth_provider_x509_cert_url: config.auth_provider_x509_cert_url,
//   client_x509_cert_url: config.client_x509_cert_url,
//   universe_domain: config.universe_domain,
// };

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });

admin.initializeApp()
// admin.initializeApp();
const db = admin.firestore();
const app = express();

// Middleware

app.use(
  cors({
    origin: "*",
    credentials: false, // Set to true only if you trust the origin and use cookies/auth headers
  })
);
// Enable CORS for all origins (adjust as needed)
app.use(express.json()); // Parse JSON request bodies

async function addApi(akey, name, url, uid) {
  try {
    // Validate input parameters
    if (!akey || !name || !url || !uid) {
      throw new Error("All parameters (key, name, url, uid) are required");
    }

    // Reference the user document
    const userRef = db.collection("user").doc(uid);
    const userDoc = await userRef.get();

    // Check if the user document exists
    if (!userDoc.exists) {
      throw new Error(`User with UID ${uid} not found`);
    }

    // Create a document in the compays collection
    const companyRef = db.collection("companys");
    await companyRef.add({
      name: name,
      url: url,
      apiKey: akey,
      uid: uid,
      status: "active",
      time: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update the user document to include the new API key
    await userRef.update({
      apiKeys: admin.firestore.FieldValue.arrayUnion({
        akey,
      }),
    });

    // console.log("API key added successfully");

    // Return success message and compay reference
    return {
      message: "API added successfully",
      company: companyRef, // Return the ID of the compays document
    };
  } catch (error) {
    console.error("Error adding API key: ", error);
    return { error: error.message };
  }
}

async function compaignsDatas(uid) {
  try {
    // Reference the companys collection and query for documents where uid matches
    const querySnapshot = await db
      .collection("companys")
      .where("uid", "==", uid)
      .get();

    // Check if any documents exist
    if (querySnapshot.empty) {
      throw new Error(`No documents found for UID ${uid}`);
    }

    // Extract data from each document
    const campaigns = [];
    querySnapshot.forEach((doc) => {
      campaigns.push({
        id: doc.id, // Document ID
        ...doc.data(), // Document data
      });
    });

    // Return the campaigns data
    return {
      success: true,
      data: campaigns,
    };
  } catch (error) {
    console.error("Error fetching compaigns data: ", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.split("Bearer ")[1];
  if (!idToken) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.uid = decodedToken.uid; // Securely verified UID
    next();
  } catch (error) {
    return res
      .status(401)
      .json({ error: "Unauthorized", details: error.message });
  }
}

async function getAllLeads(userRef) {
  const leadsCol = userRef.collection("leads");
  const snapshot = await leadsCol.count().get();
  const total = snapshot.data().count;
  // console.log(`Total leads for user: ${total}`);
  return total;
}

app.get("/", (req, res) => {
  res.send("working");
});

// Endpoint: Create a test document
app.post("/create-db", authenticate, async (req, res) => {
  try {
    const { name, email } = req.body;
    const uid = req.uid;

    if (!uid) {
      return res.status(400).json({ error: "UID is required" });
    }

    const userRef = db.collection("user").doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      // Create a new user document
      await userRef.set({
        name: name,
        email: email,
        approve: false,
        createdAt: new Date(),
        createdAtt: admin.firestore.FieldValue.serverTimestamp(),
        // Add any default fields you want for new users
      });
      // console.log(`Created new user document for uid: ${uid}`);
    }

    // await userRef.set(data);
    res.status(200).json({
      message: "Document successfully written",
      documentId: userRef.id,
    });
  } catch (error) {
    console.error("Error writing document:", error);
    res
      .status(500)
      .json({ error: "Error writing document", details: error.message });
  }
});

// Endpoint: Fetch users/leads
app.get("/users", authenticate, async (req, res) => {
  try {
    if (req.query.error === "true") {
      return res
        .status(500)
        .json({ message: "Simulated internal server error" });
    }
    const { date, endDate, campaignId, status } = req.query;
    const uid = req.uid;
    if (!uid)
      return res.status(400).json({ error: "User ID (uid) is required" });

    const userRef = db.collection("user").doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      await userRef.set({ createdAt: new Date() });
      // console.log(`Created new user document for uid: ${uid}`);
    }

    const userData = userDoc.data();
    const isMember = userData?.role === "member";
    const leadOwnerId = isMember && userData.adminId ? userData.adminId : uid;
    const leadsRef = db.collection("user").doc(leadOwnerId).collection("leads");

    let query = leadsRef;

    // Date filter
    if (date && endDate) {
      // console.log(endDate, date);
      query = query.where("date", ">=", date).where("date", "<=", endDate);
    } else if (date) {
      query = query.where("date", "==", date);
    }

    // Campaign filtering
    if (isMember) {
      const allowedCampaigns = userData.campaigns || [];

      if (allowedCampaigns.length === 0) {
        return res.status(200).json({ count: 0, leads: [] });
      }

      if (allowedCampaigns.length > 10) {
        return res
          .status(400)
          .json({ error: "Too many campaigns (max 10 for 'in' query)" });
      }

      if (campaignId) {
        query = query.where("campaignId", "==", campaignId);
      } else {
        query = query.where("campaignId", "in", allowedCampaigns);
      }
    } else {
      if (campaignId) {
        query = query.where("campaignId", "==", campaignId);
      }
    }

    // Status filter (applies to both member and admin)
    if (status) {
      query = query.where("status", "==", status);
    }

    // Fetch and return leads
    const querySnapshot = await query.get();
    const leads = querySnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const leadLength = await getAllLeads(userRef);

    return res.json({ count: leadLength, leads });
  } catch (error) {
    console.error("Error fetching leads:", error);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
});

// Endpoint: Add users
app.post("/users/add", async (req, res) => {
  try {
    const body = req.body;
    if (!body || Object.keys(body).length === 0) {
      return res.status(400).json({ error: "No data provided" });
    }

    const dbBatch = db.batch();
    const results = [];
    const users = Array.isArray(body) ? body : [body];

    for (const user of users) {
      if (!user || Object.keys(user).length === 0) {
        results.push({ error: "Empty user object skipped" });
        continue;
      }

      const userRef = db.collection("users").doc();
      const userData = {
        ...user,
        createdAt: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp
      };

      dbBatch.set(userRef, userData);
      results.push({ userId: userRef.id, status: "queued" });
    }

    await dbBatch.commit();
    res.status(201).json({ message: "Data stored successfully", results });
  } catch (error) {
    console.error("Error storing data:", error);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
});

// Endpoint: Generate API key
app.post("/generate-key", authenticate, async (req, res) => {
  try {
    const { name, url } = req.body;

    const uid = req.uid;

  //  console.log (uid, "uid");

    if (!name || !url) {
      return res
        .status(400)
        .json({ error: "All fields (name, url, uid) are required" });
    }

    const apiKey = crypto.randomBytes(16).toString("hex");
    const result = await addApi(apiKey, name, url, uid);

    res.status(201).json({
      message: "API key generated and stored successfully",
      apiKey,
      result,
    });
  } catch (error) {
    console.error("Error in /generate-key endpoint:", error);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
});

// Endpoint: Fetch campaigns data
app.get("/compaigns/datas", authenticate, async (req, res) => {
  try {
    const uid = req.uid;

    if (!uid) {
      return res.status(400).json({ error: "UID is required" });
    }

    const userRef = db.collection("user").doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();
    const isMember = userData?.role === "member";
    const adminId = isMember ? userData.adminId : uid;

    // If member: get only allowed campaign IDs
    if (isMember) {
      const allowedCampaignIds = userData.campaigns || [];
      if (allowedCampaignIds.length === 0) {
        return res.status(200).json({ data: [] });
      }

      // Fetch each all/owed campaign document
      const campaignDocs = await Promise.all(
        allowedCampaignIds.map((id) => db.collection("companys").doc(id).get())
      );

      const campaigns = campaignDocs
        .filter((doc) => doc.exists)
        .map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

      return res.status(200).json({ data: campaigns });
    }

    // If admin: fetch all campaigns where uid == adminId
    const data = await compaignsDatas(uid);
    // if (!data.success) {
    //   return res.status(404).json({ error: data.error });
    // }

    res.status(200).json({ data: data.data });
  } catch (error) {
    console.error("Error in /compaigns/datas endpoint:", error);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
});

app.delete("/campaign/:campaignId", async (req, res) => {
  const { campaignId } = req.params
  if (!campaignId) {
    return res.status(400).json({ message: "Missing campaignId" })
  }
  try {
    await db.collection("companys").doc(campaignId).delete()
    return res.status(200).json({ message: "Deleted" })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ message: "Server error" })
  }
})
app.get("/user/lables", authenticate, async (req, res) => {
  try {
    const uid = req.uid;

    if (!uid) {
      return res.status(400).json({ error: "UID is required" });
    }

    const userDocRef = db.collection("user").doc(uid);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    // Return only the labels
    const labels = userData.lable || ["new", "pending", "done"];
    res.status(200).json({ data: labels });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
});

app.post("/user/add-lable", async (req, res) => {
  try {
    const { uid, lable_name } = req.body;

    if (!uid || !lable_name) {
      return res.status(400).json({ error: "UID and label name are required" });
    }

    const userDocRef = db.collection("user").doc(uid);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    // Add default labels if missing
    if (!userData.lable || !Array.isArray(userData.lable)) {
      await userDocRef.update({
        lable: ["pending", "done", "new"],
      });
    }

    // Add the new label (as string, or object if you want)
    await userDocRef.update({
      lable: admin.firestore.FieldValue.arrayUnion(lable_name),
    });

    res.status(200).json({ message: "Label added successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
});

app.post("/user/lead-status", async (req, res) => {
  try {
    const { uid, leadId, status } = req.body;

    if (!uid || !leadId || !status) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const userDocRef = db.collection("user").doc(uid);
    const leadDocRef = userDocRef.collection("leads").doc(leadId);

    await leadDocRef.update({ status }); // 👈 Use object format for update

    res.status(200).json({ message: "Status updated successfully." });
  } catch (error) {
    console.error("Error updating lead status:", error.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.delete("/user/lable-delete", async (req, res) => {
  try {
    const { uid, labelsName } = req.body;

    if (!uid || !labelsName) {
      return res.status(400).json({ message: "Missing uid or labelsName" });
    }

    const userDocRef = db.collection("user").doc(uid);

    // Update the document and remove the label from the labels array
    await userDocRef.update({
      lable: admin.firestore.FieldValue.arrayRemove(labelsName),
    });

    return res.status(200).json({ message: "Label deleted successfully" });
  } catch (error) {
    console.error("Error deleting label:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/user/createMembers", async (req, res) => {
  try {
    const { uid, memberName, membereMail, campaigns, password } = req.body;

    // Validate all fields
    if (
      !uid ||
      !memberName ||
      !membereMail ||
      !campaigns ||
      !Array.isArray(campaigns) ||
      !password
    ) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // Create Auth user
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email: membereMail,
        password: password,
        displayName: memberName,
      });
    } catch (err) {
      if (err.code === "auth/email-already-exists") {
        return res.status(400).json({ message: "Email already exists." });
      }
      throw err;
    }

    const memberUid = userRecord.uid;
    // console.log(`New Firebase Auth user created: ${memberUid}`);

    // Create main user document if not exists
    const userRef = db.collection("user").doc(memberUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      await userRef.set({
        name: memberName,
        email: membereMail,
        campaigns: campaigns,
        approve: false,
        createdAt: new Date(),
        adminId: uid,
        role: "member",
        createdAtt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // console.log(`Created new user document for uid: ${memberUid}`);
    }

    // Add to admin's teamMembers subcollection
    const userDocRef = db.collection("user").doc(uid);
    await userDocRef.collection("teamMembers").add({
      name: memberName,
      email: membereMail,
      campaigns: campaigns,
      campaignNames: "",
      adminId: uid,
      role: "member",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res
      .status(200)
      .json({ message: "Team member created successfully." });
  } catch (error) {
    console.error("Error creating team member:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/user/memberLists", authenticate, async (req, res) => {
  try {
    const uid = req.uid;

    if (!uid) {
      return res.status(400).json({ message: "Missing required UID." });
    }

    // Reference to the user's teamMembers subcollection
    const teamMembersRef = db
      .collection("user")
      .doc(uid)
      .collection("teamMembers");
    const snapshot = await teamMembersRef.get();

    const members = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json({ teamMembers: members });
  } catch (error) {
    console.error("Error fetching team members:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});
// // Express.js route
// app.get("/api/leads/weekly", async (req, res) => {
//   const { uid, campaignId, startDate, endDate } = req.query;
//   if (!uid) return res.status(400).json({ error: "Missing uid" });

//   try {
//     const userRef = db.collection("user").doc(uid);
//     const userDoc = await userRef.get();
//     if (!userDoc.exists)
//       return res.status(404).json({ error: "User not found" });

//     const userData = userDoc.data();
//     const isMember = userData?.role === "member";
//     const adminId = isMember ? userData.adminId : uid;

//     let leadsRef = db.collection("user").doc(adminId).collection("leads");

//     // Filter by campaign
//     if (campaignId) {
//       leadsRef = leadsRef.where("campaignId", "==", campaignId);
//     } else if (isMember) {
//       const allowedCampaigns = userData.campaigns || [];
//       if (allowedCampaigns.length === 0) return res.json({});
//       if (allowedCampaigns.length > 10) {
//         return res
//           .status(400)
//           .json({ error: "Too many campaigns (max 10 allowed)" });
//       }
//       leadsRef = leadsRef.where("campaignId", "in", allowedCampaigns);
//     }

//     const snapshot = await leadsRef.get();

//     // Parse custom date range if provided
//     const start = startDate ? new Date(startDate) : null;
//     const end = endDate ? new Date(endDate) : null;

//     if (start) start.setHours(0, 0, 0, 0);
//     if (end) end.setHours(23, 59, 59, 999);

//     const counts = {};

//     snapshot.forEach((doc) => {
//       const leadDate = doc.data().date;
//       if (!leadDate) return;

//       const leadDateObj = new Date(leadDate);

//       // If within range, count it
//       if ((!start || leadDateObj >= start) && (!end || leadDateObj <= end)) {
//         const key = leadDateObj.toISOString().split("T")[0];
//         counts[key] = (counts[key] || 0) + 1;
//       }
//     });

//     // Sort the counts object by date keys
//     const sortedCounts = Object.keys(counts)
//       .sort() // string dates in ISO format naturally sort in correct order
//       .reduce((acc, key) => {
//         acc[key] = counts[key];
//         return acc;
//       }, {});

//     return res.json(sortedCounts);
//   } catch (err) {
//     console.error("Weekly leads API error:", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// });

// app.get("/user/leads/download", async (req, res) => {
//   const { uid, campaignId, startDate, endDate } = req.query;
//   if (!uid) {
//     return res.status(400).json({ error: "uid is not provide!!" });
//   }

//   const userRef = db.collection("user").doc(uid);
//   const userDoc = await userRef.get();
//   if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
//   const leadsRef = userRef.collection("leads").get;
// });

// Export as Firebase Function
// export const backed = onRequest({ region: "us-central1" }, app);


export const backed = onRequest(
  { region: "europe-west1", memory: "512MiB", cpu: 2 },
  app
);
