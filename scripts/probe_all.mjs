for (let p of [3013, 3014, 3015, 3016, 3017]) {
  try {
    let res = await fetch(`http://127.0.0.1:${p}/cdp/json/version`);
    let ver = await res.json();
    let targetsRes = await fetch(`http://127.0.0.1:${p}/cdp/json`);
    let targets = await targetsRes.json();
    let page = targets.find(t => t.type === "page") || targets[0];
    console.log(`Port ${p}: OK | Browser: ${ver.Browser} | Target: "${page ? page.title : 'none'}" (${page ? page.url : 'none'})`);
  } catch (err) {
    console.log(`Port ${p}: FAILED (${err.message})`);
  }
}
