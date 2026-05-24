import { useState, useEffect, useRef } from "react";
import { auth, googleProvider, db, storage } from "./firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import {
  collection, addDoc, deleteDoc, updateDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp, where, getDocs
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { PARENT_EMAILS, KIDS, POINTS_FOR_REWARD, REWARD_AMOUNT } from "./config";

const TODAY = () => new Date().toISOString().split("T")[0];

function getKid(email) { return KIDS.find(k => k.email === email); }
function isParent(email) { return PARENT_EMAILS.includes(email); }

function Avatar({ kid, size = 36 }) {
  return (
    <div style={{ width:size, height:size, borderRadius:"50%", background:kid.color, display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.4, fontWeight:800, color:"#fff", flexShrink:0 }}>
      {kid.initial}
    </div>
  );
}

function ProgressBar({ value, max, color = "#7C3AED" }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div style={{ background:"#2D2B3D", borderRadius:99, height:8, overflow:"hidden" }}>
      <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:99, transition:"width 0.3s" }} />
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [chores, setChores] = useState([]);
  const [completions, setCompletions] = useState([]);
  const [points, setPoints] = useState({});
  const [streaks, setStreaks] = useState({});
  const [view, setView] = useState("dashboard");
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);

  // Parent state
  const [choreForm, setChoreForm] = useState({ name:"", points:2, type:"personal", assignedTo:"", emoji:"🏠" });
  const [editingChore, setEditingChore] = useState(null);
  const [showChoreForm, setShowChoreForm] = useState(false);

  // Kid state
  const [photoUploading, setPhotoUploading] = useState(null);
  const fileRef = useRef(null);
  const [pendingChoreId, setPendingChoreId] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => { setUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  // Load chores
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "chores"), orderBy("createdAt", "asc"));
    return onSnapshot(q, snap => setChores(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, [user]);

  // Load today's completions
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "completions"), where("date", "==", TODAY()));
    return onSnapshot(q, snap => setCompletions(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, [user]);

  // Load points per kid
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "points"));
    return onSnapshot(q, snap => {
      const p = {};
      snap.docs.forEach(d => { p[d.id] = d.data().total || 0; });
      setPoints(p);
    });
  }, [user]);

  const showToast = (msg, type="success") => { setToast({msg,type}); setTimeout(()=>setToast(null),3500); };

  const handleSignIn = async () => {
    try { await signInWithPopup(auth, googleProvider); }
    catch(e) {
      if (e.code==="auth/popup-blocked") showToast("Popup blocked — allow popups for this site","error");
      else showToast("Sign-in failed","error");
    }
  };

  const handleSignOut = () => signOut(auth);

  // Kid marks chore done — upload photo
  const handleMarkDone = (choreId) => {
    setPendingChoreId(choreId);
    fileRef.current?.click();
  };

  const handlePhotoSelected = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !pendingChoreId) return;
    setPhotoUploading(pendingChoreId);
    try {
      const path = `photos/${TODAY()}/${pendingChoreId}_${user.uid}_${Date.now()}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      const chore = chores.find(c => c.id === pendingChoreId);
      await addDoc(collection(db, "completions"), {
        choreId: pendingChoreId,
        choreName: chore?.name || "",
        kidEmail: user.email,
        kidName: getKid(user.email)?.name || user.displayName,
        date: TODAY(),
        photoUrl: url,
        status: "pending",
        points: chore?.points || 0,
        createdAt: serverTimestamp()
      });
      showToast("Submitted for approval! 🎉");
    } catch(err) {
      console.error(err);
      showToast("Upload failed — try again","error");
    }
    setPhotoUploading(null);
    setPendingChoreId(null);
    e.target.value = "";
  };

  // Parent approve/reject
  const handleApprove = async (comp) => {
    await updateDoc(doc(db, "completions", comp.id), { status:"approved" });
    // Add points
    const kidEmail = comp.kidEmail;
    const ptRef = doc(db, "points", kidEmail);
    const current = points[kidEmail] || 0;
    await updateDoc(ptRef, { total: current + comp.points }).catch(async () => {
      await addDoc(collection(db, "points"), { total: comp.points });
    });
    // Use set instead
    const { setDoc } = await import("firebase/firestore");
    await setDoc(doc(db, "points", kidEmail), { total: (points[kidEmail]||0) + comp.points });
    showToast(`✓ Approved! +${comp.points} pts for ${comp.kidName}`);
  };

  const handleReject = async (comp) => {
    await updateDoc(doc(db, "completions", comp.id), { status:"rejected" });
    showToast(`Rejected — ${comp.kidName} will need to redo this`,"info");
  };

  // Parent chore management
  const handleSaveChore = async () => {
    if (!choreForm.name.trim()) { showToast("Enter a chore name","error"); return; }
    setLoading(true);
    try {
      if (editingChore) {
        await updateDoc(doc(db, "chores", editingChore), { ...choreForm, points: parseInt(choreForm.points) });
        showToast("Chore updated ✓");
      } else {
        await addDoc(collection(db, "chores"), { ...choreForm, points: parseInt(choreForm.points), createdAt: serverTimestamp() });
        showToast("Chore added ✓");
      }
      setChoreForm({ name:"", points:2, type:"personal", assignedTo:"", emoji:"🏠" });
      setEditingChore(null);
      setShowChoreForm(false);
    } catch { showToast("Something went wrong","error"); }
    setLoading(false);
  };

  const handleDeleteChore = async (id) => {
    await deleteDoc(doc(db, "chores", id));
    showToast("Chore removed","info");
  };

  const handleEditChore = (chore) => {
    setChoreForm({ name:chore.name, points:chore.points, type:chore.type, assignedTo:chore.assignedTo||"", emoji:chore.emoji||"🏠" });
    setEditingChore(chore.id);
    setShowChoreForm(true);
  };

  // Derived data
  const todayCompletions = completions.filter(c => c.date === TODAY());
  const pendingApprovals = todayCompletions.filter(c => c.status === "pending");
  const approvedToday = todayCompletions.filter(c => c.status === "approved");

  const kidEmail = user && !isParent(user.email) ? user.email : null;
  const kid = kidEmail ? getKid(kidEmail) : null;
  const kidPoints = kidEmail ? (points[kidEmail] || 0) : 0;

  // Get chores visible to this kid
  const myChores = kid ? chores.filter(c =>
    c.type === "shared" || (c.type === "personal" && c.assignedTo === kid.name)
  ) : [];

  // Check if chore is done today by anyone (shared) or by this kid (personal)
  const choreStatus = (choreId) => {
    const comp = todayCompletions.find(c => c.choreId === choreId);
    if (!comp) return "available";
    if (comp.kidEmail === kidEmail) return comp.status === "approved" ? "approved" : "pending";
    return "claimed"; // claimed by sibling
  };

  if (authLoading) return (
    <div style={S.splash}>
      <div style={S.splashIcon}>✓</div>
      <div style={S.splashTitle}><span style={S.purple}>Chore</span><span style={S.gold}>Chart</span></div>
    </div>
  );

  if (!user) return (
    <div style={S.loginBg}>
      <div style={S.loginGlow} />
      <div style={S.loginContent}>
        <div style={S.loginIconWrap}>
          <div style={S.loginIconCircle}>✓</div>
        </div>
        <div style={S.loginTitle}><span style={S.purple}>Chore</span><span style={S.gold}>Chart</span></div>
        <div style={S.loginTagline}>Teamwork today.<br/><span style={S.gold}>Rewards</span> tomorrow.</div>
        <div style={S.loginFeatures}>
          <div style={S.loginFeature}><span>✓</span> Stay organised</div>
          <div style={S.loginFeature}><span style={S.gold}>★</span> Earn points</div>
          <div style={S.loginFeature}><span>🏆</span> Reach your goals</div>
        </div>
        <button style={S.googleBtn} onClick={handleSignIn}>
          <svg width="18" height="18" viewBox="0 0 18 18" style={{marginRight:10,flexShrink:0}}>
            <path fill="#4285F4" d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18z"/>
            <path fill="#34A853" d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2a4.8 4.8 0 0 1-7.18-2.54H1.83v2.07A8 8 0 0 0 8.98 17z"/>
            <path fill="#FBBC05" d="M4.5 10.52a4.8 4.8 0 0 1 0-3.04V5.41H1.83a8 8 0 0 0 0 7.18z"/>
            <path fill="#EA4335" d="M8.98 4.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4L4.5 7.49a4.77 4.77 0 0 1 4.48-3.3z"/>
          </svg>
          Sign in with Google
        </button>
        <div style={S.loginNote}>🔒 Secure sign-in for the whole family</div>
      </div>
    </div>
  );

  // ── PARENT VIEW ──
  if (isParent(user.email)) {
    const totalToday = chores.length * KIDS.length;
    return (
      <div style={S.root}>
        {toast && <div style={{...S.toast,...(toast.type==="error"?S.toastErr:toast.type==="info"?S.toastInfo:{})}}>{toast.msg}</div>}

        <header style={S.header}>
          <div style={S.headerRow}>
            <div style={S.headerTitle}><span style={S.purple}>Chore</span><span style={S.gold}>Chart</span></div>
            <div style={S.headerRight}>
              {pendingApprovals.length > 0 && <div style={S.notifBadge}>{pendingApprovals.length}</div>}
              <button style={S.signOutBtn} onClick={handleSignOut}>Sign out</button>
            </div>
          </div>
          <div style={S.parentSub}>Parent View · Hi {user.displayName?.split(" ")[0]} 👋</div>
        </header>

        <main style={S.main}>
          {/* Stats row */}
          <div style={S.statsRow}>
            <div style={S.statCard}>
              <div style={S.statIcon}>📋</div>
              <div style={S.statNum}>{chores.length * KIDS.length}</div>
              <div style={S.statLbl}>Total Today</div>
            </div>
            <div style={{...S.statCard,background:"#1a2e1a"}}>
              <div style={S.statIcon}>✅</div>
              <div style={{...S.statNum,color:"#4ade80"}}>{approvedToday.length}</div>
              <div style={S.statLbl}>Completed</div>
            </div>
            <div style={{...S.statCard,background:pendingApprovals.length>0?"#2d1f0e":"#1e1b2e"}}>
              <div style={S.statIcon}>⏳</div>
              <div style={{...S.statNum,color:pendingApprovals.length>0?"#F59E0B":"#f0f0f0"}}>{pendingApprovals.length}</div>
              <div style={S.statLbl}>Approvals</div>
            </div>
          </div>

          {/* Kids overview */}
          <div style={S.sectionTitle}>Kids Overview</div>
          {KIDS.map(k => {
            const kDone = approvedToday.filter(c => c.kidEmail === k.email).length;
            const kPending = pendingApprovals.filter(c => c.kidEmail === k.email).length;
            const kChores = chores.filter(c => c.type==="shared" || c.assignedTo===k.name).length;
            const kPts = points[k.email] || 0;
            return (
              <div key={k.email} style={S.kidCard}>
                <Avatar kid={k} size={44} />
                <div style={{flex:1}}>
                  <div style={S.kidCardTop}>
                    <div style={S.kidName}>{k.name}</div>
                    <div style={{...S.kidPoints,color:k.color}}>{kPts} pts ●</div>
                  </div>
                  <div style={S.kidCardMeta}>
                    {kDone} done{kPending > 0 && <span style={S.pendingTag}> · {kPending} pending</span>}
                  </div>
                  <ProgressBar value={kPts} max={POINTS_FOR_REWARD} color={k.color} />
                  <div style={S.rewardLabel}>{kPts}/{POINTS_FOR_REWARD} pts · {REWARD_AMOUNT} reward</div>
                </div>
              </div>
            );
          })}

          {/* Pending approvals */}
          {pendingApprovals.length > 0 && (<>
            <div style={S.sectionTitle}>Pending Approvals</div>
            {pendingApprovals.map(comp => {
              const k = getKid(comp.kidEmail);
              return (
                <div key={comp.id} style={S.approvalCard}>
                  <div style={S.approvalLeft}>
                    {k && <Avatar kid={k} size={36} />}
                    <div>
                      <div style={S.approvalName}>{comp.kidName}</div>
                      <div style={S.approvalChore}>{comp.choreName}</div>
                      <div style={S.approvalTime}>Submitted today · {comp.points} pts</div>
                    </div>
                  </div>
                  <div style={S.approvalRight}>
                    {comp.photoUrl && (
                      <a href={comp.photoUrl} target="_blank" rel="noreferrer">
                        <img src={comp.photoUrl} alt="proof" style={S.approvalThumb} />
                      </a>
                    )}
                    <div style={S.approvalBtns}>
                      <button style={S.approveBtn} onClick={() => handleApprove(comp)}>✓ Approve</button>
                      <button style={S.rejectBtn} onClick={() => handleReject(comp)}>✕ Reject</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </>)}

          {/* Manage chores button */}
          <button style={S.manageBtn} onClick={() => setView("manage")}>⚙️ Manage / Add Chores</button>

          <div style={{height:20}} />
        </main>
      </div>
    );
  }

  // ── MANAGE CHORES VIEW (parent) ──
  if (view === "manage") return (
    <div style={S.root}>
      {toast && <div style={{...S.toast,...(toast.type==="error"?S.toastErr:toast.type==="info"?S.toastInfo:{})}}>{toast.msg}</div>}
      <div style={S.manageHeader}>
        <button style={S.backBtn} onClick={() => { setView("dashboard"); setShowChoreForm(false); }}>← Back</button>
        <div style={S.manageTitle}>Manage Chores</div>
        <button style={S.addChoreIconBtn} onClick={() => { setShowChoreForm(true); setEditingChore(null); setChoreForm({ name:"", points:2, type:"personal", assignedTo:"", emoji:"🏠" }); }}>+</button>
      </div>
      <div style={S.main}>
        {showChoreForm && (
          <div style={S.choreFormCard}>
            <div style={S.choreFormTitle}>{editingChore ? "Edit Chore" : "Add New Chore"}</div>
            <label style={S.label}>Chore name</label>
            <input style={S.input} placeholder="e.g. Tidy bedroom" value={choreForm.name}
              onChange={e => setChoreForm(f=>({...f,name:e.target.value}))} />
            <label style={S.label}>Emoji</label>
            <div style={S.emojiRow}>
              {["🛏️","🧹","🍽️","🧺","🗑️","🐾","🌿","✨","🧼","🏠"].map(em => (
                <button key={em} style={{...S.emojiBtn,...(choreForm.emoji===em?S.emojiBtnActive:{})}}
                  onClick={() => setChoreForm(f=>({...f,emoji:em}))}>{em}</button>
              ))}
            </div>
            <label style={S.label}>Points</label>
            <div style={S.pointsRow}>
              {[1,2,3,4,5].map(p => (
                <button key={p} style={{...S.pointsBtn,...(choreForm.points===p?S.pointsBtnActive:{})}}
                  onClick={() => setChoreForm(f=>({...f,points:p}))}>{p}</button>
              ))}
            </div>
            <label style={S.label}>Type</label>
            <div style={S.typeRow}>
              <button style={{...S.typeBtn,...(choreForm.type==="personal"?S.typeBtnActive:{})}}
                onClick={() => setChoreForm(f=>({...f,type:"personal"}))}>Personal</button>
              <button style={{...S.typeBtn,...(choreForm.type==="shared"?S.typeBtnActive:{})}}
                onClick={() => setChoreForm(f=>({...f,type:"shared"}))}>Shared (first wins)</button>
            </div>
            {choreForm.type === "personal" && (
              <>
                <label style={S.label}>Assign to</label>
                <div style={S.typeRow}>
                  {KIDS.map(k => (
                    <button key={k.name} style={{...S.typeBtn,...(choreForm.assignedTo===k.name?{...S.typeBtnActive,background:k.color+"33",borderColor:k.color,color:k.color}:{})}}
                      onClick={() => setChoreForm(f=>({...f,assignedTo:k.name}))}>{k.name}</button>
                  ))}
                </div>
              </>
            )}
            <button style={{...S.saveChoreBtn,opacity:loading?0.7:1}} onClick={handleSaveChore} disabled={loading}>
              {loading?"Saving…":editingChore?"Save Changes":"Add Chore"}
            </button>
          </div>
        )}

        <div style={S.choreList}>
          {chores.map(chore => (
            <div key={chore.id} style={S.choreManageCard}>
              <div style={S.choreManageLeft}>
                <div style={S.choreManageEmoji}>{chore.emoji || "🏠"}</div>
                <div>
                  <div style={S.choreManageName}>{chore.name}</div>
                  <div style={S.choreManageMeta}>
                    {chore.type==="shared" ? "Shared · First to do it wins" : `Personal · ${chore.assignedTo}`}
                  </div>
                </div>
              </div>
              <div style={S.choreManageRight}>
                <div style={S.pointsBadge}>{chore.points} pts</div>
                <button style={S.editIconBtn} onClick={() => handleEditChore(chore)}>✏️</button>
                <button style={S.deleteIconBtn} onClick={() => handleDeleteChore(chore.id)}>🗑️</button>
              </div>
            </div>
          ))}
        </div>
        <div style={{height:20}} />
      </div>
    </div>
  );

  // ── KID VIEW ──
  if (kid) {
    const streak = streaks[kidEmail] || 0;
    const ptsToGo = Math.max(0, POINTS_FOR_REWARD - kidPoints);

    return (
      <div style={S.root}>
        {toast && <div style={{...S.toast,...(toast.type==="error"?S.toastErr:toast.type==="info"?S.toastInfo:{})}}>{toast.msg}</div>}
        <input type="file" accept="image/*" capture="environment" ref={fileRef} style={{display:"none"}} onChange={handlePhotoSelected} />

        <header style={S.header}>
          <div style={S.headerRow}>
            <div style={S.kidGreeting}>Hey {kid.name}! 👋</div>
            <button style={S.signOutBtn} onClick={handleSignOut}>Sign out</button>
          </div>
        </header>

        <main style={S.main}>
          {/* Points card */}
          <div style={{...S.pointsCard, borderColor: kid.color+"44"}}>
            <div style={S.pointsCardTop}>
              <div>
                <div style={S.pointsLabel}>Your Points</div>
                <div style={S.pointsBig}><span style={{color:kid.color}}>{kidPoints}</span> <span style={{fontSize:20}}>⭐</span></div>
              </div>
              <div style={S.rewardBox}>
                <div style={S.rewardIcon}>🎁</div>
                <div style={S.rewardText}>{ptsToGo > 0 ? `${ptsToGo} to go for ${REWARD_AMOUNT}` : `🎉 Claim your ${REWARD_AMOUNT}!`}</div>
              </div>
            </div>
            <ProgressBar value={kidPoints} max={POINTS_FOR_REWARD} color={kid.color} />
            <div style={S.progressLabel}>{kidPoints} / {POINTS_FOR_REWARD} pts</div>
          </div>

          {/* Streak */}
          {streak > 0 && (
            <div style={S.streakCard}>
              <span style={{fontSize:24}}>🔥</span>
              <div>
                <div style={S.streakTitle}>{streak} Day Streak</div>
                <div style={S.streakSub}>Keep it up! 🔥</div>
              </div>
              <span style={S.streakArrow}>›</span>
            </div>
          )}

          {/* Today's chores */}
          <div style={S.sectionTitle}>Today's Chores</div>
          {myChores.length === 0 && (
            <div style={S.emptyChores}>No chores assigned yet — check back soon!</div>
          )}
          {myChores.map(chore => {
            const status = choreStatus(chore.id);
            const comp = todayCompletions.find(c => c.choreId === chore.id);
            const claimedByName = status === "claimed" ? comp?.kidName : null;
            return (
              <div key={chore.id} style={{...S.choreCard,...(status!=="available"?S.choreCardDone:{})}}>
                <div style={S.choreCardTop}>
                  <div style={S.choreCardLeft}>
                    <div style={{...S.choreEmoji,...(status==="claimed"?{opacity:0.4}:{})}}>{chore.emoji||"🏠"}</div>
                    <div>
                      <div style={{...S.choreName,...(status==="claimed"?{opacity:0.4}:{})}}>{chore.name}</div>
                      <div style={S.choreMeta}>
                        {chore.type==="shared" ? "Shared · First to do it wins" : "Personal daily chore"}
                      </div>
                      {status === "claimed" && <div style={S.claimedTag}>Completed by {claimedByName}</div>}
                      {status === "pending" && <div style={S.pendingTagKid}>⏳ Awaiting approval</div>}
                    </div>
                  </div>
                  <div style={{...S.chorePtsBadge,background:kid.color+"22",color:kid.color,borderColor:kid.color+"44"}}>
                    {chore.points} pts
                  </div>
                </div>

                {status === "available" && (
                  <div style={S.choreActions}>
                    <button style={{...S.markDoneBtn,background:kid.color,opacity:photoUploading===chore.id?0.6:1}}
                      onClick={() => handleMarkDone(chore.id)}
                      disabled={photoUploading===chore.id}>
                      {photoUploading===chore.id ? "Uploading…" : "Mark as done"}
                    </button>
                    <button style={S.cameraBtn} onClick={() => handleMarkDone(chore.id)}>📷</button>
                  </div>
                )}
                {status === "approved" && (
                  <div style={S.doneTag}>✓ Done & approved! +{chore.points} pts</div>
                )}
              </div>
            );
          })}
          <div style={{height:20}} />
        </main>
      </div>
    );
  }

  // Unrecognised account
  return (
    <div style={S.root}>
      <div style={{padding:40,textAlign:"center",color:"#9ca3af"}}>
        <div style={{fontSize:48,marginBottom:16}}>🔒</div>
        <div style={{fontSize:18,fontWeight:700,color:"#f0f0f0",marginBottom:8}}>Account not recognised</div>
        <div style={{fontSize:14,marginBottom:24}}>Your email ({user.email}) isn't set up in ChoreChart yet. Ask a parent to add you.</div>
        <button style={S.signOutBtn} onClick={handleSignOut}>Sign out</button>
      </div>
    </div>
  );
}

const S = {
  splash:{minHeight:"100vh",background:"#13111C",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12},
  splashIcon:{fontSize:48,color:"#7C3AED"},
  splashTitle:{fontSize:36,fontWeight:800,letterSpacing:"-1px"},
  purple:{color:"#7C3AED"},gold:{color:"#F59E0B"},
  loginBg:{minHeight:"100vh",background:"linear-gradient(160deg,#13111C 0%,#1e1535 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:24,position:"relative"},
  loginGlow:{position:"absolute",top:0,left:"50%",transform:"translateX(-50%)",width:400,height:400,background:"radial-gradient(circle,rgba(124,58,237,0.15) 0%,transparent 70%)",pointerEvents:"none"},
  loginContent:{position:"relative",zIndex:1,textAlign:"center",maxWidth:320,width:"100%"},
  loginIconWrap:{marginBottom:16},
  loginIconCircle:{width:72,height:72,borderRadius:"50%",background:"linear-gradient(135deg,#7C3AED,#5B21B6)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,color:"#fff",margin:"0 auto",boxShadow:"0 8px 32px rgba(124,58,237,0.4)"},
  loginTitle:{fontSize:42,fontWeight:800,letterSpacing:"-1px",marginBottom:8},
  loginTagline:{fontSize:18,color:"#9ca3af",lineHeight:1.6,marginBottom:28},
  loginFeatures:{display:"flex",flexDirection:"column",gap:10,marginBottom:36,textAlign:"left",background:"rgba(255,255,255,0.04)",borderRadius:14,padding:"16px 20px"},
  loginFeature:{fontSize:14,color:"#d1d5db",display:"flex",alignItems:"center",gap:10},
  googleBtn:{display:"flex",alignItems:"center",justifyContent:"center",width:"100%",background:"#fff",color:"#111",border:"none",borderRadius:12,padding:"14px 20px",fontSize:15,fontWeight:600,cursor:"pointer",marginBottom:14},
  loginNote:{fontSize:12,color:"#4b5563"},
  root:{minHeight:"100vh",background:"#13111C",color:"#f0f0f0",fontFamily:"'Inter',sans-serif",paddingBottom:24},
  header:{background:"#13111C",borderBottom:"1px solid #2D2B3D",padding:"16px 16px 12px"},
  headerRow:{display:"flex",justifyContent:"space-between",alignItems:"center"},
  headerTitle:{fontSize:20,fontWeight:800,letterSpacing:"-0.5px"},
  headerRight:{display:"flex",alignItems:"center",gap:10,position:"relative"},
  notifBadge:{position:"absolute",top:-8,right:50,background:"#EF4444",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700},
  parentSub:{fontSize:12,color:"#6b7280",marginTop:4},
  signOutBtn:{background:"transparent",border:"1px solid #2D2B3D",borderRadius:8,color:"#6b7280",padding:"6px 12px",fontSize:12,cursor:"pointer"},
  main:{padding:"16px"},
  statsRow:{display:"flex",gap:10,marginBottom:20},
  statCard:{flex:1,background:"#1e1b2e",border:"1px solid #2D2B3D",borderRadius:14,padding:"14px 8px",textAlign:"center"},
  statIcon:{fontSize:20,marginBottom:4},
  statNum:{fontSize:24,fontWeight:800,color:"#f0f0f0"},
  statLbl:{fontSize:10,color:"#6b7280",marginTop:2},
  sectionTitle:{fontSize:15,fontWeight:700,color:"#f0f0f0",marginBottom:12,marginTop:4},
  kidCard:{background:"#1e1b2e",border:"1px solid #2D2B3D",borderRadius:14,padding:"14px",display:"flex",gap:12,alignItems:"center",marginBottom:10},
  kidCardTop:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4},
  kidName:{fontSize:15,fontWeight:700,color:"#f0f0f0"},
  kidPoints:{fontSize:13,fontWeight:700},
  kidCardMeta:{fontSize:12,color:"#6b7280",marginBottom:6},
  pendingTag:{color:"#F59E0B"},
  rewardLabel:{fontSize:10,color:"#6b7280",marginTop:4},
  approvalCard:{background:"#1e1b2e",border:"1px solid #2D2B3D",borderRadius:14,padding:"14px",display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,gap:10},
  approvalLeft:{display:"flex",gap:10,alignItems:"flex-start",flex:1},
  approvalName:{fontSize:14,fontWeight:700,color:"#f0f0f0"},
  approvalChore:{fontSize:12,color:"#9ca3af",marginTop:2},
  approvalTime:{fontSize:11,color:"#6b7280",marginTop:2},
  approvalRight:{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6},
  approvalThumb:{width:52,height:52,borderRadius:8,objectFit:"cover",border:"1px solid #2D2B3D"},
  approvalBtns:{display:"flex",flexDirection:"column",gap:4},
  approveBtn:{background:"rgba(74,222,128,0.15)",border:"1px solid rgba(74,222,128,0.4)",borderRadius:8,color:"#4ade80",padding:"5px 10px",fontSize:12,cursor:"pointer",fontWeight:600,whiteSpace:"nowrap"},
  rejectBtn:{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,color:"#f87171",padding:"5px 10px",fontSize:12,cursor:"pointer",fontWeight:600,whiteSpace:"nowrap"},
  manageBtn:{width:"100%",background:"linear-gradient(135deg,#7C3AED,#5B21B6)",color:"#fff",border:"none",borderRadius:14,padding:"16px",fontSize:15,fontWeight:700,cursor:"pointer",marginTop:16,boxShadow:"0 4px 16px rgba(124,58,237,0.3)"},
  manageHeader:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px"},
  backBtn:{background:"transparent",border:"none",color:"#7C3AED",fontSize:15,cursor:"pointer",fontWeight:500},
  manageTitle:{fontSize:18,fontWeight:700,color:"#f0f0f0"},
  addChoreIconBtn:{width:36,height:36,borderRadius:"50%",background:"#7C3AED",color:"#fff",border:"none",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"},
  choreFormCard:{background:"#1e1b2e",border:"1px solid #2D2B3D",borderRadius:16,padding:20,marginBottom:16},
  choreFormTitle:{fontSize:16,fontWeight:700,color:"#f0f0f0",marginBottom:4},
  label:{display:"block",fontSize:12,color:"#6b7280",marginBottom:6,marginTop:14,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5},
  input:{width:"100%",background:"#13111C",border:"1px solid #2D2B3D",borderRadius:10,padding:"12px 14px",color:"#f0f0f0",fontSize:15,boxSizing:"border-box",outline:"none"},
  emojiRow:{display:"flex",gap:8,flexWrap:"wrap"},
  emojiBtn:{background:"#13111C",border:"1px solid #2D2B3D",borderRadius:8,padding:"8px",fontSize:20,cursor:"pointer"},
  emojiBtnActive:{borderColor:"#7C3AED",background:"rgba(124,58,237,0.15)"},
  pointsRow:{display:"flex",gap:8},
  pointsBtn:{flex:1,background:"#13111C",border:"1px solid #2D2B3D",borderRadius:8,padding:"10px",color:"#9ca3af",fontSize:14,cursor:"pointer",fontWeight:600},
  pointsBtnActive:{background:"rgba(124,58,237,0.2)",borderColor:"#7C3AED",color:"#a78bfa"},
  typeRow:{display:"flex",gap:8},
  typeBtn:{flex:1,background:"#13111C",border:"1px solid #2D2B3D",borderRadius:8,padding:"10px",color:"#9ca3af",fontSize:13,cursor:"pointer",fontWeight:500,textAlign:"center"},
  typeBtnActive:{background:"rgba(124,58,237,0.2)",borderColor:"#7C3AED",color:"#a78bfa"},
  saveChoreBtn:{width:"100%",background:"#7C3AED",color:"#fff",border:"none",borderRadius:12,padding:"14px",fontSize:15,fontWeight:700,cursor:"pointer",marginTop:20},
  choreList:{display:"flex",flexDirection:"column",gap:10},
  choreManageCard:{background:"#1e1b2e",border:"1px solid #2D2B3D",borderRadius:12,padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10},
  choreManageLeft:{display:"flex",gap:12,alignItems:"center",flex:1},
  choreManageEmoji:{fontSize:24},
  choreManageName:{fontSize:14,fontWeight:600,color:"#f0f0f0"},
  choreManageMeta:{fontSize:11,color:"#6b7280",marginTop:2},
  choreManageRight:{display:"flex",alignItems:"center",gap:8},
  pointsBadge:{background:"rgba(124,58,237,0.2)",border:"1px solid rgba(124,58,237,0.3)",borderRadius:6,padding:"2px 8px",fontSize:11,color:"#a78bfa",fontWeight:700},
  editIconBtn:{background:"transparent",border:"none",fontSize:16,cursor:"pointer",padding:4},
  deleteIconBtn:{background:"transparent",border:"none",fontSize:16,cursor:"pointer",padding:4},
  kidGreeting:{fontSize:20,fontWeight:800,color:"#f0f0f0"},
  pointsCard:{background:"#1e1b2e",border:"2px solid #2D2B3D",borderRadius:16,padding:"16px",marginBottom:12},
  pointsCardTop:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12},
  pointsLabel:{fontSize:12,color:"#6b7280",marginBottom:4},
  pointsBig:{fontSize:32,fontWeight:800,color:"#f0f0f0",lineHeight:1},
  rewardBox:{textAlign:"right"},
  rewardIcon:{fontSize:28},
  rewardText:{fontSize:11,color:"#9ca3af",marginTop:4},
  progressLabel:{fontSize:11,color:"#6b7280",textAlign:"right",marginTop:4},
  streakCard:{background:"#1e1b2e",border:"1px solid #2D2B3D",borderRadius:14,padding:"14px",display:"flex",alignItems:"center",gap:12,marginBottom:12},
  streakTitle:{fontSize:15,fontWeight:700,color:"#f0f0f0"},
  streakSub:{fontSize:12,color:"#6b7280"},
  streakArrow:{fontSize:20,color:"#6b7280",marginLeft:"auto"},
  emptyChores:{textAlign:"center",padding:"40px 20px",color:"#6b7280",fontSize:14},
  choreCard:{background:"#1e1b2e",border:"1px solid #2D2B3D",borderRadius:14,padding:"14px",marginBottom:10},
  choreCardDone:{opacity:0.7},
  choreCardTop:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10},
  choreCardLeft:{display:"flex",gap:12,alignItems:"flex-start",flex:1},
  choreEmoji:{fontSize:28,lineHeight:1},
  choreName:{fontSize:15,fontWeight:700,color:"#f0f0f0",marginBottom:3},
  choreMeta:{fontSize:12,color:"#6b7280"},
  claimedTag:{fontSize:11,color:"#6b7280",marginTop:4,fontStyle:"italic"},
  pendingTagKid:{fontSize:11,color:"#F59E0B",marginTop:4,fontWeight:600},
  chorePtsBadge:{border:"1px solid",borderRadius:8,padding:"4px 10px",fontSize:12,fontWeight:700,flexShrink:0},
  choreActions:{display:"flex",gap:10},
  markDoneBtn:{flex:1,border:"none",borderRadius:10,padding:"11px",fontSize:14,fontWeight:700,cursor:"pointer",color:"#fff"},
  cameraBtn:{background:"#2D2B3D",border:"none",borderRadius:10,padding:"11px 14px",fontSize:18,cursor:"pointer"},
  doneTag:{background:"rgba(74,222,128,0.1)",border:"1px solid rgba(74,222,128,0.3)",borderRadius:8,padding:"8px 12px",fontSize:13,color:"#4ade80",fontWeight:600,textAlign:"center"},
  toast:{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:"#7C3AED",color:"#fff",borderRadius:10,padding:"12px 20px",fontSize:14,fontWeight:600,zIndex:999,boxShadow:"0 4px 20px rgba(0,0,0,0.5)",maxWidth:"90vw",textAlign:"center"},
  toastErr:{background:"#dc2626"},
  toastInfo:{background:"#1e1b2e",border:"1px solid #2D2B3D",color:"#9ca3af"},
};
