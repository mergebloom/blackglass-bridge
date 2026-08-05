(() => {
  "use strict";

  const menuButton = document.querySelector(".menu-button");
  const navigation = document.querySelector("#site-nav");
  const status = document.querySelector(".copy-status");

  if (menuButton && navigation) {
    menuButton.addEventListener("click", () => {
      const isOpen = navigation.classList.toggle("open");
      menuButton.setAttribute("aria-expanded", String(isOpen));
    });

    navigation.addEventListener("click", (event) => {
      if (event.target instanceof HTMLAnchorElement) {
        navigation.classList.remove("open");
        menuButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Copy command was rejected");
  };

  let statusTimer;
  const announce = (message) => {
    if (!status) return;
    status.textContent = message;
    status.classList.add("visible");
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => status.classList.remove("visible"), 2200);
  };

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetId = button.getAttribute("data-copy");
      const target = targetId ? document.getElementById(targetId) : null;
      if (!target) {
        announce("That text could not be found.");
        return;
      }

      const originalLabel = button.textContent;
      try {
        await copyText(target.textContent.trim());
        button.textContent = "Copied";
        announce("Copied to your clipboard.");
      } catch {
        announce("Copy failed. Select the text and copy it manually.");
      } finally {
        window.setTimeout(() => {
          button.textContent = originalLabel;
        }, 1600);
      }
    });
  });

  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
