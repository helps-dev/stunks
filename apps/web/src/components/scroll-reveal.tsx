"use client";

import { useEffect } from "react";

/**
 * Reveal elements as they enter the viewport.
 *
 * Opt in per element with `data-reveal`, and optionally `data-reveal-delay="1".."5"`
 * to stagger a row of cards.
 *
 * THE NO-JAVASCRIPT RULE, WHICH IS WHY THE CLASS GOES ON <html>
 *
 * The hidden state is scoped to `html.reveal-ready`, and only this component sets that
 * class. So the starting state is "visible", and the animation is what JavaScript adds
 * — not what it takes away. Hiding by default and revealing with script is the common
 * shortcut, and it turns any script failure into a blank page. On a page whose whole
 * claim is that it shows real on-chain data rather than plausible placeholders, an
 * invisible page is the worst possible failure.
 *
 * The class is set in an effect rather than during render, so the server-rendered HTML
 * never carries it and hydration cannot mismatch.
 */
export function ScrollReveal() {
  useEffect(() => {
    const root = document.documentElement;

    // Respect the OS setting. Someone who asked for less motion gets the content, in
    // place, with nothing sliding.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    if (!("IntersectionObserver" in window)) return;
    root.classList.add("reveal-ready");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-revealed");
          // Once revealed, stay revealed. Re-animating on every scroll past is the
          // thing that makes these effects tiring rather than pleasant.
          observer.unobserve(entry.target);
        }
      },
      // A small negative bottom margin means the reveal happens just after the element
      // has genuinely entered, not while it is still a sliver at the edge.
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );

    const observe = (scope: ParentNode): void => {
      for (const node of scope.querySelectorAll("[data-reveal]:not(.is-revealed)")) {
        observer.observe(node);
      }
    };
    observe(document);

    // App Router navigations swap the tree without remounting this component, and the
    // explore page appends cards as more are loaded. Without this, anything arriving
    // after the first pass would keep the hidden state forever.
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const element = node as Element;
          if (element.matches("[data-reveal]")) observer.observe(element);
          observe(element);
        }
      }
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
      root.classList.remove("reveal-ready");
    };
  }, []);

  return null;
}
