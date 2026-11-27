// Central tunables. Everything gameplay-related that you might want to tweak lives here.
export const CONFIG = {
  physics: {
    step: 1 / 120,        // fixed physics step (s)
    maxSubSteps: 6,
    gravity: -9.81,
    solverIterations: 18,
  },

  map: {
    floorSize: 800,       // visual floor (fades into fog; also under the hidden title-screen set)
    titleSpot: [0, -1000], // the title screen's set: far outside the play area, lost in the fog
    boundary: 45,         // invisible walls at +-boundary (m)
    skyColor: 0x9ea4aa,
  },

  player: {
    spawn: [0, 0, 7],
    height: 1.8,
    crouchHeight: 1.15,
    eyeHeight: 1.64,
    crouchEyeHeight: 1.02,
    radius: 0.32,
    walkSpeed: 4.3,
    sprintSpeed: 7.2,
    crouchSpeed: 2.1,
    adsSpeedMul: 0.6,
    groundAccel: 60,
    airAccel: 10,
    friction: 10,
    jumpSpeed: 5.6,
    gravity: 19,
    stepHeight: 0.36,
    coyoteTime: 0.1,
    jumpBuffer: 0.12,
    mouseSensitivity: 0.0021,
    lookSmoothing: 0.0,    // 0 = raw mouse, 0..0.8 = smoother/laggier
    fov: 75,
    sprintFovBoost: 7,
    bob: { walkFreq: 1.9, amp: 0.045, sideAmp: 0.028, roll: 0.012 },
    strafeTilt: 0.018,
    interactRange: 2.6,
  },

  weapon: {
    magSize: 7,
    startReserve: 56,
    minShotInterval: 0.11,     // semi-auto cap (s)
    hipSpread: 0.010,          // radians
    adsSpread: 0.0015,
    moveSpread: 0.02,
    range: 120,
    impulse: 11,               // N*s pushed into the body part that is hit
    recoil: {
      pitch: 0.055,            // camera kick (rad)
      yaw: 0.014,
      recover: 0.72,           // fraction of kick the "shooter" pulls back down
      viewKickBack: 0.055,     // viewmodel z kick (m)
      viewKickRot: 0.22,       // viewmodel muzzle flip (rad)
    },
    hipPos: [0.13, -0.155, -0.37],      // grip pivot position in camera space
    gripOffset: [0, 0.06, -0.02],      // model offset from the grip pivot (recoil rotates around the hand)
    adsPos: [0, -0.0812, -0.25],
    infiniteReserve: true,
    weaponFov: 58,
    adsFovMul: 0.82,
  },

  ragdoll: {
    spawn: [0, 0, -2],
    wanderRadius: 3.2,
    walkSpeed: 0.85,
    runSpeed: 1.75,            // running away from the player
    standHeight: 0.972,        // pelvis target height while standing (legs straight = 0.98)
  },

  physiology: {
    bloodVolume: 5000,          // ml
    clotTime: 70,               // s, venous wounds slow down with this time constant
    arterialClotTime: 400,
    arrestDeathTime: 45,        // s of no circulation before brain death (gameplay-compressed)
  },

  gore: {
    maxParticles: 4000,
    maxPools: 260,
    maxDecals: 160,
    maxGibs: 40,
    maxCasings: 40,
  },
};
