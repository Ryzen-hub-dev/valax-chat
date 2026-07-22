const header = document.querySelector("[data-header]");
const menuButton = document.querySelector(".menu-toggle");
const mobileMenu = document.querySelector("#mobile-menu");
const composer = document.querySelector("[data-composer]");
const preview = document.querySelector("[data-preview]");
const characterCount = document.querySelector("[data-character-count]");
const sendDemoButton = document.querySelector("[data-send-demo]");

const updateHeader = () => {
  header?.classList.toggle("is-scrolled", window.scrollY > 16);
};

const setMenu = (isOpen) => {
  if (!menuButton || !mobileMenu) return;

  menuButton.setAttribute("aria-expanded", String(isOpen));
  menuButton.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
  menuButton.setAttribute("title", isOpen ? "Close menu" : "Open menu");
  mobileMenu.hidden = !isOpen;
  document.body.classList.toggle("menu-open", isOpen);
  header?.classList.toggle("is-menu-open", isOpen);

  menuButton.innerHTML = `<i data-lucide="${isOpen ? "x" : "menu"}" aria-hidden="true"></i>`;
  window.lucide?.createIcons();
};

menuButton?.addEventListener("click", () => {
  setMenu(menuButton.getAttribute("aria-expanded") !== "true");
});

mobileMenu?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenu(false));
});

window.addEventListener("scroll", updateHeader, { passive: true });
updateHeader();

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 }
);

document.querySelectorAll(".reveal").forEach((element, index) => {
  element.style.transitionDelay = `${Math.min(index % 4, 3) * 70}ms`;
  revealObserver.observe(element);
});

const demoValues = () => {
  const now = new Date();
  return {
    "/date": new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(now),
    "/time": new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(now),
    "/@": "@Alex",
    "/server": "Valax Community",
  };
};

const renderMessage = () => {
  if (!composer || !preview || !characterCount) return;

  const source = composer.value.slice(0, 2000);
  if (source !== composer.value) composer.value = source;

  const finalMessage = Object.entries(demoValues()).reduce(
    (message, [token, value]) => message.replaceAll(token, value),
    source
  );

  preview.textContent = finalMessage || "Your finished message will appear here.";
  characterCount.textContent = `${source.length.toLocaleString()} / 2,000`;
};

composer?.addEventListener("input", renderMessage);

document.querySelectorAll("[data-token]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!composer) return;

    const token = button.dataset.token;
    const start = composer.selectionStart;
    const end = composer.selectionEnd;
    const needsSpace = start > 0 && !/\s/.test(composer.value[start - 1]);
    const insertion = `${needsSpace ? " " : ""}${token}`;
    composer.setRangeText(insertion, start, end, "end");
    composer.focus();
    renderMessage();
  });
});

sendDemoButton?.addEventListener("click", () => {
  if (!sendDemoButton) return;

  sendDemoButton.innerHTML = '<i data-lucide="check" aria-hidden="true"></i> Preview updated';
  sendDemoButton.style.background = "var(--green)";
  window.lucide?.createIcons();
  window.setTimeout(() => {
    sendDemoButton.innerHTML = '<i data-lucide="send" aria-hidden="true"></i> Preview ready';
    sendDemoButton.style.background = "";
    window.lucide?.createIcons();
  }, 1500);
});

document.querySelector("[data-year]").textContent = new Date().getFullYear();
renderMessage();
window.lucide?.createIcons();

const startScene = async () => {
  const canvas = document.querySelector("[data-scene]");
  const hero = document.querySelector(".hero");
  if (!canvas || !hero || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  try {
    const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js");
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 12);

    const group = new THREE.Group();
    group.position.set(3.35, 0.2, 0);
    scene.add(group);

    const coreGeometry = new THREE.IcosahedronGeometry(2.15, 1);
    const coreMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x111111,
      metalness: 0.68,
      roughness: 0.25,
      clearcoat: 1,
      clearcoatRoughness: 0.2,
      transparent: true,
      opacity: 0.96,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    group.add(core);

    const coreEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(coreGeometry),
      new THREE.LineBasicMaterial({ color: 0xffe500, transparent: true, opacity: 0.74 })
    );
    core.add(coreEdges);

    const innerGeometry = new THREE.OctahedronGeometry(0.95, 0);
    const inner = new THREE.Mesh(
      innerGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffe500, wireframe: true, transparent: true, opacity: 0.9 })
    );
    group.add(inner);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.15, 0.018, 8, 160),
      new THREE.MeshBasicMaterial({ color: 0x777771, transparent: true, opacity: 0.55 })
    );
    ring.rotation.set(1.12, 0.25, 0.18);
    group.add(ring);

    const nodeColors = [0xffe500, 0x7c83ff, 0x64d98b, 0xff7168];
    const nodePositions = [
      [-3.1, 1.35, 0.1],
      [3.2, 1.0, -0.45],
      [2.5, -2.25, 0.35],
      [-2.45, -2.35, -0.35],
      [0.25, 3.25, -0.25],
    ];

    const linePoints = [];
    nodePositions.forEach((position, index) => {
      const node = new THREE.Mesh(
        new THREE.BoxGeometry(0.48, 0.48, 0.48),
        new THREE.MeshStandardMaterial({
          color: nodeColors[index % nodeColors.length],
          metalness: 0.25,
          roughness: 0.35,
        })
      );
      node.position.set(...position);
      node.rotation.set(index * 0.4, index * 0.7, index * 0.25);
      node.userData.speed = 0.25 + index * 0.04;
      group.add(node);

      linePoints.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(...position));
    });

    const connections = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(linePoints),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13 })
    );
    group.add(connections);

    const ambient = new THREE.AmbientLight(0xffffff, 1.6);
    const keyLight = new THREE.DirectionalLight(0xfff7bc, 4.8);
    keyLight.position.set(5, 6, 8);
    const violetLight = new THREE.PointLight(0x7c83ff, 20, 18);
    violetLight.position.set(-3, -2, 5);
    scene.add(ambient, keyLight, violetLight);

    const pointer = { x: 0, y: 0 };
    window.addEventListener(
      "pointermove",
      (event) => {
        pointer.x = (event.clientX / window.innerWidth - 0.5) * 2;
        pointer.y = (event.clientY / window.innerHeight - 0.5) * 2;
      },
      { passive: true }
    );

    const resize = () => {
      const { width, height } = hero.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      group.position.x = width < 760 ? 1.7 : 3.25;
      group.position.y = width < 760 ? 3.6 : 0.25;
      group.scale.setScalar(width < 760 ? 0.68 : 1);
    };

    resize();
    window.addEventListener("resize", resize, { passive: true });

    const clock = new THREE.Clock();
    let frameId;
    const animate = () => {
      const elapsed = clock.getElapsedTime();
      group.rotation.y += (pointer.x * 0.12 - group.rotation.y) * 0.035;
      group.rotation.x += (-pointer.y * 0.08 - group.rotation.x) * 0.035;
      core.rotation.y = elapsed * 0.09;
      core.rotation.x = Math.sin(elapsed * 0.25) * 0.12;
      inner.rotation.x = elapsed * 0.36;
      inner.rotation.y = elapsed * 0.42;
      ring.rotation.z = elapsed * 0.06;

      group.children.forEach((child) => {
        if (child.userData.speed) {
          child.rotation.x += child.userData.speed * 0.008;
          child.rotation.y += child.userData.speed * 0.012;
        }
      });

      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    animate();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frameId);
      } else {
        clock.getDelta();
        animate();
      }
    });
  } catch (error) {
    console.warn("Valax 3D scene could not start.", error);
  }
};

startScene();
