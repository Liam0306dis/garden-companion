export function installPetSpriteLoader(): void {
  const script = document.createElement('script');
  script.textContent = __PET_SPRITE_LOADER__;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}
